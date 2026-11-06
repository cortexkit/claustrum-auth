import { expect, spyOn, test } from 'bun:test'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import {
  acquireLimitsRegistry,
  canonicalLimitsPath,
  LimitsEnvelopeConflictError,
  LimitsEnvelopeUnsupportedError,
  type LimitsRegistry,
} from '@cortexkit/common-auth/limits'
import { createFetch } from '../src/fetch.js'
import { createAccountLimits, isLocalLimitRefusal } from '../src/limits.js'
import { fixtureEntries } from '../test-entry.ts'
import { harness, row } from './fakes.ts'

const placeholder = 'owned-placeholder'
const headers = { authorization: `Bearer ${placeholder}` }
const mark = {
  scope: { kind: 'pool' as const },
  window: 'retry',
  until: 121000,
  cause: 'rate-limit' as const,
  mergeLaw: 'overwrite' as const,
}

async function setup() {
  const h = await harness(
    [row('a')],
    'opencode1',
    () => 1000,
    fixtureEntries.slice(0, 1),
  )
  return {
    h,
    route: h.consumer.routingRows()[0].id,
    options: {
      provider: 'fixture-a',
      path: h.hub.rosterPath('fixture-a'),
      consumer: h.consumer,
      now: () => 1000,
    },
  }
}

function sender(
  h: Awaited<ReturnType<typeof harness>>,
  limits: Awaited<ReturnType<typeof createAccountLimits>>,
  status = 200,
) {
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    now: () => 1000,
    limits: async () => limits,
    fetch: async () =>
      new Response('provider reached', {
        status,
        headers: { 'retry-after': '120' },
      }),
  })
  return () => fetch('https://fixture.invalid', { headers })
}

async function replaceEnvelope(path: string, limits: unknown) {
  const roster = JSON.parse(await readFile(path, 'utf8'))
  roster.limits = limits
  await writeFile(path, JSON.stringify(roster))
}

test('foreign namespace live mark does not refuse the first owned request and is replaced on save', async () => {
  const { h, route, options } = await setup()
  const initial = await h.limits('fixture-a')
  initial.mark(initial.observe(route), mark)
  await initial.flush()
  const persisted = (await readVaultRoster(options.path))?.limits
  expect(persisted).toMatchObject({ marks: [expect.any(Object)] })
  await h.disposeLimits()
  const foreign = JSON.parse(
    JSON.stringify(persisted, (key, value) =>
      key === 'namespace' ? 'foreign-namespace' : value,
    ),
  )
  await replaceEnvelope(options.path, foreign)
  const limits = await h.limits('fixture-a')
  const response = await sender(h, limits, 429)()
  expect(response.status).toBe(429)
  expect(isLocalLimitRefusal(response)).toBe(false)
  expect(await response.text()).toBe('provider reached')
  expect(h.reads).toEqual(['a'])
  await limits.flush()
  expect((await readVaultRoster(options.path))?.limits).toMatchObject({
    namespace: JSON.stringify([
      'claustrum-auth',
      'fixture-a',
      canonicalLimitsPath(options.path),
    ]),
    marks: [expect.any(Object)],
  })
})

for (const ErrorType of [
  LimitsEnvelopeConflictError,
  LimitsEnvelopeUnsupportedError,
]) {
  test(`acquisition ${ErrorType.name} serves without tracking or reacquiring the store`, async () => {
    const { h, route, options } = await setup()
    const warnings: string[] = []
    let acquisitions = 0
    const acquire = async () => {
      acquisitions++
      throw new ErrorType()
    }
    const limits = await createAccountLimits(options, acquire, (message) =>
      warnings.push(message),
    )
    try {
      const send = sender(h, limits)
      for (let i = 0; i < 2; i++) {
        const response = await send()
        expect(response.status).toBe(200)
        expect(isLocalLimitRefusal(response)).toBe(false)
      }
      expect(await limits.marks()).toEqual(new Map())
      expect(limits.observe(route)).toMatchObject({
        rateProbe: false,
        paymentProbe: false,
      })
      expect(warnings).toEqual(['claustrum-auth: limits tracking disabled'])
      await limits.dispose()
      const next = await createAccountLimits(options, acquire, (message) =>
        warnings.push(message),
      )
      await next.dispose()
      expect(acquisitions).toBe(1)
      expect(warnings).toHaveLength(1)
      expect(h.reads).toEqual(['a', 'a'])
    } finally {
      await limits.dispose()
    }
  })
}

test('real unsupported acquisition logs one fixed warning even without an error callback', async () => {
  const { h, options } = await setup()
  await replaceEnvelope(options.path, { schemaVersion: 2 })
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const limits = await h.limits('fixture-a')
    expect((await sender(h, limits)()).status).toBe(200)
    await h.disposeLimits()
    const recreated = await h.limits('fixture-a')
    expect((await sender(h, recreated)()).status).toBe(200)
    expect(warning.mock.calls).toEqual([
      ['claustrum-auth: limits tracking disabled'],
    ])
    expect((await readVaultRoster(options.path))?.limits).toEqual({
      schemaVersion: 2,
    })
  } finally {
    warning.mockRestore()
  }
})

test('abandonment after hydration releases the registry and serves the next request without stale marks or probes', async () => {
  const { h, route, options } = await setup()
  const warnings: string[] = []
  let owner: LimitsRegistry | undefined
  let disposals = 0
  const limits = await createAccountLimits(
    options,
    async (input) => {
      const registry = await acquireLimitsRegistry(input)
      owner = registry
      return new Proxy(registry, {
        get(target, key) {
          if (key === 'dispose')
            return async () => {
              disposals++
              await target.dispose()
            }
          return Reflect.get(target, key)
        },
      })
    },
    (message) => warnings.push(message),
  )
  try {
    limits.mark(limits.observe(route), mark)
    await limits.flush()
    expect(await limits.marks()).toEqual(new Map([[route, 121000]]))
    await replaceEnvelope(options.path, { schemaVersion: 2 })
    await owner?.reload()
    expect(owner?.abandoned).toBe('unsupported')
    const response = await sender(h, limits)()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('provider reached')
    expect(h.reads).toEqual(['a'])
    expect(await limits.marks()).toEqual(new Map())
    expect(limits.observe(route)).toMatchObject({
      rateProbe: false,
      paymentProbe: false,
    })
    expect(disposals).toBe(1)
    expect(warnings).toEqual(['claustrum-auth: limits tracking disabled'])
    await limits.flush()
    await limits.dispose()
    expect((await readVaultRoster(options.path))?.limits).toEqual({
      schemaVersion: 2,
    })
  } finally {
    await limits.dispose()
  }
})

test('disabled tracking drops limit replies with one redacted log per process and no fallback marks', async () => {
  const warnings: string[] = []
  for (let store = 0; store < 2; store++) {
    const { h, options } = await setup()
    const limits = await createAccountLimits(
      options,
      async () => {
        throw new LimitsEnvelopeUnsupportedError()
      },
      (message) => warnings.push(message),
    )
    try {
      for (let reply = 0; reply < 2; reply++) {
        const response = await sender(h, limits, 429)()
        expect(response.status).toBe(429)
        expect(isLocalLimitRefusal(response)).toBe(false)
        expect(await response.text()).toBe('provider reached')
      }
      expect(await limits.marks()).toEqual(new Map())
      expect(h.reads).toEqual(['a', 'a'])
    } finally {
      await limits.dispose()
    }
  }
  expect(warnings).toEqual([
    'claustrum-auth: limits tracking disabled',
    'claustrum-auth: limit reply dropped; tracking disabled',
    'claustrum-auth: limits tracking disabled',
  ])
})

// Windows owner-only files refuse a state folder reached through a reparse
// point (junction or symlink) before any read, so an aliased roster path can't
// serve there and has no namespace to share.
test.skipIf(process.platform === 'win32')(
  'symlinked state folder shares the real-path namespace and live marks',
  async () => {
    const { h, route, options } = await setup()
    const alias = join(h.dir, 'alias')
    await symlink(dirname(options.path), alias, 'dir')
    const real = await createAccountLimits(options)
    const linked = await createAccountLimits({
      ...options,
      path: join(alias, basename(options.path)),
    })
    try {
      expect(real.observe(route).binding.account.namespace).toBe(
        linked.observe(route).binding.account.namespace,
      )
      real.mark(real.observe(route), mark)
      expect(await linked.marks()).toEqual(new Map([[route, 121000]]))
    } finally {
      await real.dispose()
      await linked.dispose()
    }
  },
)
