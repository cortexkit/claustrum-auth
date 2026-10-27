import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type ActivationContext,
  type AuthApi,
  commandHelp,
  releaseProvider,
  useProvider,
} from '../src/v1/activation.ts'
import { effectiveCredential, hostEnvironment } from '../src/v1/effective.ts'
import { ReleasedFlags } from '../src/v1/flags.ts'
import { concurrentWriteWarning } from '../src/v1/messages.ts'
import { isPlaceholderEntry, placeholderFor } from '../src/v1/placeholder.ts'
import { scratchRoot } from './scratch-root.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true })
})

async function scratch() {
  const root = scratchRoot()
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'opencode1-'))
  cleanup.push(dir)
  return dir
}

const P = 'fixture-a'
const user = { type: 'api', key: 'user-own-key' }
const placeholder = { type: 'api', key: placeholderFor(P) }

// A fake of OpenCode 1's auth API with its real write semantics: `set` and
// `remove` read the whole file, change one key and write the whole file back,
// so another writer landing inside a write is lost. Hooks run before each
// read, inside a write after its snapshot is taken, and after the write.
function fakeAuth(initial: Record<string, unknown> = {}) {
  const file: Record<string, unknown> = structuredClone(initial)
  const writes: string[] = []
  let reads = 0
  const hooks: {
    beforeRead?: (index: number) => void
    insideWrite?: () => void
    afterWrite?: () => void
  } = {}
  let override = false
  const replace = (next: Record<string, unknown>) => {
    for (const key of Object.keys(file)) delete file[key]
    Object.assign(file, next)
  }
  const api: AuthApi = {
    async read(provider) {
      hooks.beforeRead?.(++reads)
      const value = file[provider]
      return value === undefined
        ? undefined
        : structuredClone(value as Record<string, unknown>)
    },
    async set(provider, entry) {
      const snapshot = structuredClone(file)
      hooks.insideWrite?.()
      replace({ ...snapshot, [provider]: entry })
      writes.push(`set ${provider}`)
      hooks.afterWrite?.()
    },
    async remove(provider) {
      const snapshot = structuredClone(file)
      hooks.insideWrite?.()
      delete snapshot[provider]
      replace(snapshot)
      writes.push(`remove ${provider}`)
      hooks.afterWrite?.()
    },
    contentOverride: () => override,
  }
  return {
    api,
    file,
    writes,
    hooks,
    reads: () => reads,
    setOverride(value: boolean) {
      override = value
    },
  }
}

async function context(
  auth: AuthApi,
  extra: Partial<ActivationContext> = {},
): Promise<ActivationContext & { flags: ReleasedFlags; stateDir: string }> {
  const stateDir = await scratch()
  return {
    auth,
    stateDir,
    flags: new ReleasedFlags(stateDir),
    listed: (provider) => provider === P,
    vault: async () => ({ vaultOn: true, routable: true }),
    env: () => ({}),
    envNames: async () => ['FIXTURE_A_API_KEY'],
    configApiKey: () => false,
    platform: 'linux',
    ...extra,
  }
}

test('use writes the placeholder into an empty, ineffective slot and clears released', async () => {
  const auth = fakeAuth()
  const ctx = await context(auth.api)
  await ctx.flags.set(P, true)
  const outcome = await useProvider(ctx, P)
  expect(outcome.ok).toBe(true)
  expect(auth.file[P]).toEqual(placeholder)
  expect(auth.writes).toEqual([`set ${P}`])
  expect(await ctx.flags.isReleased(P)).toBe(false)
})

test('use refuses over each effective user credential and writes nothing', async () => {
  const cases: [string, Record<string, unknown>, Partial<ActivationContext>][] =
    [
      ['opencode auth logout', { [P]: user }, {}],
      [
        'FIXTURE_A_API_KEY',
        {},
        { env: () => ({ FIXTURE_A_API_KEY: 'from-env' }) },
      ],
      ['provider.fixture-a.options.apiKey', {}, { configApiKey: () => true }],
    ]
  for (const [named, initial, extra] of cases) {
    const auth = fakeAuth(initial)
    const outcome = await useProvider(await context(auth.api, extra), P)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain(named)
    expect(auth.writes).toEqual([])
    expect(auth.file[P]).toEqual(initial[P])
  }
})

test('use refuses without vault mode, without a routable row, and under OPENCODE_AUTH_CONTENT', async () => {
  for (const [vault, text] of [
    [{ vaultOn: false, routable: true }, 'vault mode is off'],
    [{ vaultOn: true, routable: false }, 'no vault account'],
  ] as const) {
    const auth = fakeAuth()
    const outcome = await useProvider(
      await context(auth.api, { vault: async () => vault }),
      P,
    )
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.message).toContain(text)
    expect(auth.writes).toEqual([])
  }
  const auth = fakeAuth()
  auth.setOverride(true)
  const outcome = await useProvider(await context(auth.api), P)
  expect(outcome.message).toContain('OPENCODE_AUTH_CONTENT')
  expect(auth.writes).toEqual([])
  expect(
    (
      await useProvider(
        await context(fakeAuth().api, { listed: () => false }),
        'openai',
      )
    ).ok,
  ).toBe(false)
})

test('use names an account list the plugin could not save, instead of no account, and writes nothing', async () => {
  const auth = fakeAuth()
  const outcome = await useProvider(
    await context(auth.api, {
      vault: async () => ({ vaultOn: true, routable: false, unsaved: 'EPERM' }),
    }),
    P,
  )
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain(
    `local account list for ${P} could not be saved (EPERM)`,
  )
  expect(outcome.message).not.toContain('no vault account')
  expect(auth.writes).toEqual([])
})

test('a login completed before the last read makes use refuse and keeps the user key', async () => {
  const auth = fakeAuth()
  // Read 1 is the early check; read 2 is the last read before the write.
  auth.hooks.beforeRead = (index) => {
    if (index === 2) auth.file[P] = structuredClone(user)
  }
  const outcome = await useProvider(await context(auth.api), P)
  expect(auth.reads()).toBe(2)
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain('opencode auth logout')
  expect(auth.writes).toEqual([])
  expect(auth.file[P]).toEqual(user)
})

test('an env key set before the last read makes use refuse', async () => {
  const auth = fakeAuth()
  const env: Record<string, string> = {}
  auth.hooks.beforeRead = (index) => {
    if (index === 2) env.FIXTURE_A_API_KEY = 'late'
  }
  const outcome = await useProvider(
    await context(auth.api, { env: () => ({ ...env }) }),
    P,
  )
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain('FIXTURE_A_API_KEY')
  expect(auth.writes).toEqual([])
})

test('detectable schedule: a login after the write survives, is reported, and nothing more is written', async () => {
  const auth = fakeAuth()
  auth.hooks.afterWrite = () => {
    auth.file[P] = structuredClone(user)
  }
  const ctx = await context(auth.api)
  await ctx.flags.set(P, true)
  const outcome = await useProvider(ctx, P)
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain('another login for fixture-a changed')
  expect(auth.writes).toEqual([`set ${P}`])
  expect(auth.file[P]).toEqual(user)
  // A use that did not take keeps the provider released.
  expect(await ctx.flags.isReleased(P)).toBe(true)
})

test('undetectable schedules: a login inside the write is overwritten and no detection is claimed', async () => {
  for (const other of [P, 'other-provider']) {
    const auth = fakeAuth()
    auth.hooks.insideWrite = () => {
      auth.file[other] = structuredClone(user)
      auth.hooks.insideWrite = undefined
    }
    const outcome = await useProvider(await context(auth.api), P)
    // The plugin's write replaced the whole file: the other login is gone and
    // the re-read shows only the placeholder, so nothing can be reported.
    expect(outcome.ok).toBe(true)
    expect(outcome.message).not.toContain('another login')
    expect(auth.file[P]).toEqual(placeholder)
    expect(auth.file[other]).toEqual(other === P ? placeholder : undefined)
  }
  expect(commandHelp()).toContain(concurrentWriteWarning)
  expect(concurrentWriteWarning).toContain('logging in to any provider')
})

test('release persists released first and removes only the exact placeholder', async () => {
  const auth = fakeAuth({ [P]: placeholder, keep: user })
  const ctx = await context(auth.api)
  let releasedAtRemove: unknown
  auth.hooks.insideWrite = () => {
    // Read synchronously at the moment of the removal.
    releasedAtRemove = JSON.parse(
      readFileSync(
        path.join(ctx.stateDir, 'opencode1-activation.json'),
        'utf8',
      ),
    ).released
  }
  const outcome = await releaseProvider(ctx, P)
  expect(outcome.ok).toBe(true)
  expect(releasedAtRemove).toEqual([P])
  expect(auth.file).toEqual({ keep: user })
  expect(await ctx.flags.isReleased(P)).toBe(true)
  // A persisted release survives a new flags reader, as after a restart.
  expect(await new ReleasedFlags(ctx.stateDir).isReleased(P)).toBe(true)
})

test('release leaves a user login completed before the last read, and an entry with extra fields', async () => {
  for (const entry of [user, { ...placeholder, metadata: { a: 'b' } }]) {
    const auth = fakeAuth({ [P]: placeholder })
    auth.hooks.beforeRead = () => {
      auth.file[P] = structuredClone(entry)
    }
    const outcome = await releaseProvider(await context(auth.api), P)
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toContain('left as it is')
    expect(auth.writes).toEqual([])
    expect(auth.file[P]).toEqual(entry)
  }
})

test('release detects a login that lands after its removal', async () => {
  const auth = fakeAuth({ [P]: placeholder })
  auth.hooks.afterWrite = () => {
    auth.file[P] = structuredClone(user)
  }
  const outcome = await releaseProvider(await context(auth.api), P)
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain('another login for fixture-a changed')
  expect(auth.writes).toEqual([`remove ${P}`])
  expect(auth.file[P]).toEqual(user)
})

test('placeholder recognition is exact', () => {
  expect(isPlaceholderEntry(placeholder, P)).toBe(true)
  for (const entry of [
    { type: 'api', key: `${placeholderFor(P)} ` },
    { type: 'oauth', key: placeholderFor(P) },
    { type: 'api', key: placeholderFor('fixture-b') },
    { ...placeholder, extra: 1 },
    undefined,
  ])
    expect(isPlaceholderEntry(entry, P)).toBe(false)
})

test('the env check looks names up exactly, as OpenCode 1 does in its copy of the environment', () => {
  const env = hostEnvironment({ Fixture_A_Api_Key: 'mixed-case' })
  expect(
    effectiveCredential({
      provider: P,
      stored: undefined,
      env,
      envNames: ['FIXTURE_A_API_KEY'],
      configApiKey: false,
    }),
  ).toBeUndefined()
  expect(
    effectiveCredential({
      provider: P,
      stored: undefined,
      env: hostEnvironment({ FIXTURE_A_API_KEY: 'exact' }),
      envNames: ['FIXTURE_A_API_KEY'],
      configApiKey: false,
    }),
  ).toEqual({ source: 'env', variable: 'FIXTURE_A_API_KEY' })
  expect(
    effectiveCredential({
      provider: P,
      stored: placeholder,
      env: {},
      envNames: [],
      configApiKey: false,
    }),
  ).toBeUndefined()
})
