import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type ClaustrumScopedClient,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import type { PluginInput } from '@opencode-ai/plugin'
import { harness, row } from '../../core/test/fakes.ts'
import { createTestCore, fixtureEntries } from '../../core/test-entry.ts'
import type { AuthApi } from '../src/v1/activation.ts'
import { providerFetch } from '../src/v1/fetch.ts'
import { placeholderFor } from '../src/v1/placeholder.ts'
import { commandName, opencode1Hosts } from '../src/v1/plugin.ts'
import { scratchRoot } from './scratch-root.ts'

const P = 'fixture-a'
const bearer = { authorization: `Bearer ${placeholderFor(P)}` }
const entryA = fixtureEntries[0]
const url = 'https://fixture.invalid/v1/chat/completions'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

async function served(env: Record<string, string> = {}) {
  const h = await harness([row('a')])
  const calls: { via: string; auth: string | null; url: string }[] = []
  const record =
    (via: string) =>
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push({
        via,
        auth: request.headers.get('authorization'),
        url: request.url,
      })
      return new Response('ok')
    }
  const fetch = providerFetch({
    provider: P,
    entry: entryA,
    consumer: h.consumer,
    previous: record('previous'),
    transport: record('transport'),
    envNames: async () => ['FIXTURE_A_API_KEY'],
    env: () => env,
    platform: 'linux',
  })
  return { h, calls, fetch }
}

test('a request without the placeholder goes to the previous fetch with the caller arguments', async () => {
  const { h, calls, fetch } = await served({ FIXTURE_A_API_KEY: 'user' })
  const init = { headers: { authorization: 'Bearer user-key' } }
  let seen: unknown[] = []
  const passthrough = providerFetch({
    provider: P,
    entry: entryA,
    consumer: h.consumer,
    previous: async (...args) => {
      seen = args
      return new Response('foreign')
    },
    envNames: async () => ['FIXTURE_A_API_KEY'],
  })
  expect(await (await passthrough(url, init)).text()).toBe('foreign')
  expect(seen[0]).toBe(url)
  expect(seen[1]).toBe(init)
  await fetch(url, init)
  expect(calls).toEqual([{ via: 'previous', auth: 'Bearer user-key', url }])
  expect(h.reads).toEqual([])
  expect(h.reports).toEqual([])
})

test('an owned request is served through the transport with the vault key, never the previous fetch', async () => {
  const { h, calls, fetch } = await served()
  const response = await fetch(url, {
    method: 'POST',
    headers: bearer,
    body: '{}',
  })
  expect(await response.text()).toBe('ok')
  expect(calls).toEqual([{ via: 'transport', auth: 'Bearer secret-a-1', url }])
  expect(h.reads).toEqual(['a'])
})

test('a set provider env variable refuses the owned request as shadowed, with no vault read', async () => {
  const { h, calls, fetch } = await served({ FIXTURE_A_API_KEY: 'user' })
  const error = await fetch(url, { headers: bearer }).catch((e) => e)
  expect(error).toMatchObject({
    name: 'ClaustrumRefusal',
    code: 'credential-shadowed',
  })
  expect(error.message).toContain('your key in FIXTURE_A_API_KEY is shadowed')
  expect(error.message).toContain(`${'/claustrum'} release fixture-a`)
  expect(error.message).toContain('unset FIXTURE_A_API_KEY')
  expect(calls).toEqual([])
  expect(h.reads).toEqual([])
})

test('a differently cased variable is not the host key, so the request is served', async () => {
  const { h, calls, fetch } = await served({ Fixture_A_Api_Key: 'user' })
  await fetch(url, { headers: bearer })
  expect(calls[0]?.auth).toBe('Bearer secret-a-1')
  expect(h.reads).toEqual(['a'])
})

test('placement and origin refusals carry fixed text and read nothing', async () => {
  const { h, calls, fetch } = await served()
  const misplaced = await fetch(url, {
    headers: { ...bearer, 'x-api-key': placeholderFor(P) },
  }).catch((e) => e)
  expect(misplaced).toMatchObject({ code: 'placement-refused' })
  expect(misplaced.message).toContain('only serves keys sent in Authorization')
  const elsewhere = await fetch('https://elsewhere.invalid/v1', {
    headers: bearer,
  }).catch((e) => e)
  expect(elsewhere).toMatchObject({ code: 'origin-refused' })
  expect(elsewhere.message).toContain('provider.fixture-a.options.baseURL')
  expect(elsewhere.message).not.toContain('elsewhere.invalid')
  expect(calls).toEqual([])
  expect(h.reads).toEqual([])
})

test('an owned request with no account asks for a discovery and names an outage or vault mode off', async () => {
  const h = await harness([])
  const sent: string[] = []
  for (const [state, code] of [
    ['unreachable', 'vault-unreachable'],
    ['off', 'vault-mode-off'],
    ['listed', 'no-vault-account'],
  ] as const) {
    let asked = 0
    const fetch = providerFetch({
      provider: P,
      entry: entryA,
      consumer: h.consumer,
      transport: async (input) => {
        sent.push(String(input))
        return new Response('ok')
      },
      envNames: async () => [],
      env: () => ({}),
      discover: async () => {
        asked++
        return state
      },
    })
    const error = await fetch(url, { headers: bearer }).catch((e) => e)
    expect(error).toMatchObject({ name: 'ClaustrumRefusal', code })
    expect(asked).toBe(1)
  }
  // A refusal before ownership is decided never asks.
  let asked = 0
  const misplaced = providerFetch({
    provider: P,
    entry: entryA,
    consumer: h.consumer,
    envNames: async () => [],
    discover: async () => {
      asked++
      return 'unreachable'
    },
  })
  await expect(
    misplaced('https://elsewhere.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'origin-refused' })
  expect(asked).toBe(0)
  expect(sent).toEqual([])
  expect(h.reads).toEqual([])
})

type LooseConfig = {
  command: Record<string, unknown>
  provider: Record<
    string,
    {
      options: {
        fetch?: (input: string, init?: RequestInit) => Promise<Response>
      }
    }
  >
}

async function pluginHarness() {
  const root = scratchRoot()
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'opencode1-plugin-'))
  dirs.push(dir)
  const reads: string[] = []
  const client: ClaustrumScopedClient = {
    async listScoped() {
      return {
        rows: [row('a'), row('openai', { providerIds: ['openai'] })],
        view: 'v1',
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      reads.push(credentialId)
      return {
        credentialId,
        material: `secret-${credentialId}`,
        accountId: `account-${credentialId}`,
        recordVersion: 1,
        expiresAtMs: null,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const stored: Record<string, unknown> = {}
  const writes: string[] = []
  const authApi: AuthApi = {
    async read(provider) {
      return stored[provider] as Record<string, unknown> | undefined
    },
    async set(provider, entry) {
      writes.push(`set ${provider}`)
      stored[provider] = entry
    },
    async remove(provider) {
      writes.push(`remove ${provider}`)
      delete stored[provider]
    },
    contentOverride: () => false,
  }
  const shown: string[] = []
  const input = {
    client: {
      provider: {
        list: async () => ({
          data: { all: [{ id: P, env: ['CATALOG_FIXTURE_KEY'] }] },
        }),
      },
      session: {
        promptAsync: async (request: {
          body: { parts: { text: string }[] }
        }) => {
          shown.push(request.body.parts[0]?.text ?? '')
        },
      },
    },
    serverUrl: new URL('http://127.0.0.1:1'),
  } as unknown as PluginInput
  const env: Record<string, string> = {}
  await writeJsonAtomic(
    hostEnrollmentPaths({ stateDir: dir, host: 'opencode' }).tokenPath,
    { token: '01'.repeat(32), token_generation: 1 },
  )
  const hooks = opencode1Hosts(
    {
      table: fixtureEntries,
      createCore: (options) => {
        const core = createTestCore(options)
        return core
      },
      stateDir: () => dir,
      connect: async () => client,
      isCustodyActive: async () => true,
      authApi: () => authApi,
      env: () => env,
      platform: 'linux',
    },
    input,
  )
  return { hooks, stored, writes, shown, reads, env, dir }
}

test('the config hook wraps every listed provider, keeps an earlier fetch and registers the command', async () => {
  const h = await pluginHarness()
  let earlier = 0
  const earlierFetch = async () => {
    earlier++
    return new Response('earlier')
  }
  const config = {
    command: { other: { template: 'x' } },
    provider: {
      [P]: { env: ['FIXTURE_A_API_KEY'], options: { fetch: earlierFetch } },
      'fixture-b': { options: { apiKey: 'config-key' } },
      openai: { options: {} },
    },
  } as unknown as LooseConfig
  await h.hooks.config?.(config as never)
  expect(Object.keys(config.command).sort()).toEqual([commandName, 'other'])
  expect(commandName).toBe('claustrum')
  for (const id of ['fixture-a', 'fixture-b', 'fixture-c'])
    expect(typeof config.provider[id].options.fetch).toBe('function')
  expect(config.provider[P].options.fetch).not.toBe(earlierFetch)
  expect(config.provider.openai.options.fetch).toBeUndefined()
  const foreign = await config.provider[P].options.fetch?.(url, {
    headers: { authorization: 'Bearer user' },
  })
  expect(await foreign?.text()).toBe('earlier')
  expect(earlier).toBe(1)
  // The config env and the catalog env both count for the shadow check.
  for (const variable of ['FIXTURE_A_API_KEY', 'CATALOG_FIXTURE_KEY']) {
    for (const key of Object.keys(h.env)) delete h.env[key]
    h.env[variable] = 'user'
    const error = await config.provider[P].options
      .fetch?.(url, { headers: bearer })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'credential-shadowed' })
    expect((error as Error).message).toContain(variable)
  }
  expect(h.reads).toEqual([])
  // A config apiKey is an effective user credential for `use`.
  await expect(
    h.hooks['command.execute.before']?.(
      { command: commandName, arguments: 'use fixture-b', sessionID: 's' },
      { parts: [] },
    ),
  ).rejects.toThrow('__CLAUSTRUM_AUTH_COMMAND_HANDLED__')
  expect(h.shown.at(-1)).toContain('provider.fixture-b.options.apiKey')
  expect(h.writes).toEqual([])
  await h.hooks.dispose?.()
})

test('the command hook runs use and release and ignores other commands', async () => {
  const h = await pluginHarness()
  await h.hooks.config?.({
    provider: { [P]: { env: ['FIXTURE_A_API_KEY'] } },
  } as never)
  const run = (args: string) =>
    h.hooks['command.execute.before']?.(
      { command: commandName, arguments: args, sessionID: 's' },
      { parts: [] },
    )
  await expect(
    h.hooks['command.execute.before']?.(
      { command: 'other', arguments: '', sessionID: 's' },
      { parts: [] },
    ),
  ).resolves.toBeUndefined()
  h.env.FIXTURE_A_API_KEY = 'user'
  await expect(run(`use ${P}`)).rejects.toThrow('HANDLED')
  expect(h.shown.at(-1)).toContain('FIXTURE_A_API_KEY')
  expect(h.writes).toEqual([])
  delete h.env.FIXTURE_A_API_KEY
  await expect(run(`use ${P}`)).rejects.toThrow('HANDLED')
  expect(h.shown.at(-1)).toContain('now uses the vault')
  expect(h.stored[P]).toEqual({ type: 'api', key: placeholderFor(P) })
  await expect(run(`release ${P}`)).rejects.toThrow('HANDLED')
  expect(h.shown.at(-1)).toContain('placeholder removed')
  expect(h.stored[P]).toBeUndefined()
  await expect(run('')).rejects.toThrow('HANDLED')
  expect(h.shown.at(-1)).toContain('logging in to any provider')
  await expect(run('use openai')).rejects.toThrow('HANDLED')
  expect(h.shown.at(-1)).toContain('not a provider')
  expect(h.writes).toEqual([`set ${P}`, `remove ${P}`])
  await h.hooks.dispose?.()
})
