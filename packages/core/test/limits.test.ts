import { expect, test } from 'bun:test'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import { createFetch } from '../src/fetch.js'
import { limitFromReply, limitMarkUntil } from '../src/limits.js'
import { fixtureEntries } from '../test-entry.ts'
import { harness, row } from './fakes.ts'

const account = { namespace: 'fixture', accountId: 'a', incarnation: 'one' }
const placeholder = 'owned-placeholder'
const headers = { authorization: `Bearer ${placeholder}` }

for (const count of [1, 2]) {
  test(`${count} balance-marked accounts refuse with the payment cause on a fresh request`, async () => {
    const h = await harness(
      Array.from({ length: count }, (_, index) => row(String(index))),
    )
    let sends = 0
    const fetch = createFetch({
      entry: { ...fixtureEntries[0], service: 'deepseek' },
      placeholder,
      consumer: h.consumer,
      limits: () => h.limits('fixture-a'),
      fetch: async () => {
        sends++
        return new Response('Insufficient Balance', { status: 402 })
      },
    })
    expect((await fetch('https://fixture.invalid', { headers })).status).toBe(
      402,
    )
    const local = await fetch('https://fixture.invalid', { headers })
    expect(local.status).toBe(402)
    expect(await local.text()).toMatch(/balance|payment/i)
    expect(sends).toBe(count)
  })
}

test('an overflowing balance Retry-After uses the five-minute mark default', async () => {
  const h = await harness()
  let sends = 0
  const fetch = createFetch({
    entry: { ...fixtureEntries[0], service: 'deepseek' },
    placeholder,
    consumer: h.consumer,
    limits: () => h.limits('fixture-a'),
    fetch: async () => {
      sends++
      return new Response('Insufficient Balance', {
        status: 402,
        headers: { 'retry-after': '1e308' },
      })
    },
  })
  await fetch('https://fixture.invalid', { headers })
  const local = await fetch('https://fixture.invalid', { headers })
  expect(local.headers.get('retry-after')).toBe('300')
  expect(sends).toBe(1)
})

test('an overflowing rate Retry-After uses the one-minute mark default', async () => {
  const h = await harness([row('a')], 'opencode1', () => 1000)
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    now: () => 1000,
    rateLimitMarks: new Map(),
    fetch: async () =>
      new Response('rate', {
        status: 429,
        headers: { 'retry-after': '1e308' },
      }),
  })
  await fetch('https://fixture.invalid', { headers })
  const local = await fetch('https://fixture.invalid', { headers })
  expect(local.headers.get('retry-after')).toBe('60')
  expect(h.reads).toEqual(['a'])
})

test('a cold-start top-up probe clears expired balance evidence before a delayed writer returns', async () => {
  let time = 1000
  const h = await harness([row('a')], 'opencode1', () => time)
  const first = await h.limits('fixture-a')
  const route = h.consumer.routingRows()[0].id
  const delayed = first.observe(route)
  let status = 402
  const fetch = createFetch({
    entry: { ...fixtureEntries[0], service: 'deepseek' },
    placeholder,
    consumer: h.consumer,
    now: () => time,
    limits: () => h.limits('fixture-a'),
    fetch: async () => new Response('probe', { status }),
  })
  await fetch('https://fixture.invalid', { headers })
  await first.flush()
  await h.disposeLimits()
  time = 301000
  status = 200
  expect((await fetch('https://fixture.invalid', { headers })).status).toBe(200)
  const fresh = await h.limits('fixture-a')
  await fresh.beforeDispatch(route)
  fresh.mark(delayed, {
    scope: { kind: 'pool' },
    mergeLaw: 'overwrite',
    cause: 'payment-balance',
    until: 7201000,
  })
  await fresh.flush()
  expect((await fresh.marks()).has(route)).toBe(false)
})

for (const [value, expected] of [
  ['17', 18000],
  ['0', 1000],
  ['Thu, 01 Jan 1970 00:00:11 GMT', 11000],
  [undefined, 61000],
  ['', 61000],
  ['invalid', 61000],
  ['Thu, 01 Jan 1970 00:00:01 GMT', 61000],
] as const) {
  test(`CL retry hints from HTTP replies: ${value ?? 'absent'}`, async () => {
    const reply = new Response('{"error":{"message":"limited"}}', {
      status: 429,
      headers: value === undefined ? {} : { 'retry-after': value },
    })
    const parsed = await limitFromReply({
      account,
      service: 'fixture-a',
      status: reply.status,
      headers: reply.headers,
      body: () => reply.clone().text(),
      now: 1000,
    })
    expect(parsed?.kind).toBe('rate-limit')
    expect(parsed?.windows.every((window) => !window.confirmed)).toBe(true)
    if (!parsed) throw new Error('Expected a rate-limit signal')
    expect(limitMarkUntil(parsed, 'opencode1', 1000)).toBe(expected)
    expect(limitMarkUntil(parsed, 'pi', 1000)).toBe(expected)
  })
}

test('CL-5 generic reset headers do not extend a status-only mark', async () => {
  const parsed = await limitFromReply({
    account,
    service: 'fixture-a',
    status: 429,
    now: 1000,
    headers: new Headers({
      'retry-after-ms': '180000',
      'x-ratelimit-reset-requests': '2h',
    }),
    body: async () => '{"resetAt":7201000}',
  })
  expect(parsed?.retryAfterMs).toBeUndefined()
  if (!parsed) throw new Error('Expected a rate-limit signal')
  expect(limitMarkUntil(parsed, 'opencode1', 1000)).toBe(61000)
})

test('provider balance parsing produces payment signals, not cap or unknown 402 signals', async () => {
  for (const [service, body, kind] of [
    ['deepseek', '{}', 'payment-balance'],
    [
      'openrouter',
      '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}',
      'payment-balance',
    ],
    [
      'openrouter',
      '{"error":{"metadata":{"limit_source":"openrouter_credits","reason":"weight_exceeds_budget"}}}',
      undefined,
    ],
    [
      'openrouter',
      '{"error":{"metadata":{"limit_source":"key_spend_limit"}}}',
      undefined,
    ],
    ['openrouter', 'not-json', undefined],
    ['fixture-a', '{"error":"Insufficient Balance"}', undefined],
  ] as const) {
    const reply = new Response(body, { status: 402 })
    const parsed = await limitFromReply({
      account,
      service,
      status: reply.status,
      headers: reply.headers,
      body: () => reply.clone().text(),
      now: 1000,
    })
    expect({ service, body, kind: parsed?.kind }).toEqual({
      service,
      body,
      kind,
    })
    if (parsed) expect(limitMarkUntil(parsed, 'opencode1', 1000)).toBe(301000)
  }
  for (const status of [401, 403, 503])
    expect(
      await limitFromReply({
        account,
        service: 'deepseek',
        status,
        headers: new Headers(),
        now: 1000,
      }),
    ).toBeUndefined()
})

test('shared vault marks survive the last registry owner and a recreated fetch', async () => {
  const h = await harness([row('a'), row('b')])
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    limits: () => h.limits('fixture-a'),
    fetch: async (input: string | URL | Request) =>
      new Response('provider', {
        status:
          (input as Request).headers.get('authorization') ===
          'Bearer secret-a-1'
            ? 429
            : 200,
        headers: { 'retry-after': '120' },
      }),
  }
  expect(
    (await createFetch(options)('https://fixture.invalid', { headers })).status,
  ).toBe(200)
  await (await h.limits('fixture-a')).flush()
  const persisted = await readVaultRoster(h.hub.rosterPath('fixture-a'))
  expect(persisted?.limits).toMatchObject({ marks: [expect.any(Object)] })
  await h.disposeLimits()
  h.reads.length = 0
  expect(
    (await createFetch(options)('https://fixture.invalid', { headers })).status,
  ).toBe(200)
  expect(h.reads).toEqual(['b'])
})

test('a successful expired-mark probe fences delayed pre-clear marks', async () => {
  const h = await harness()
  const limits = await h.limits('fixture-a')
  const route = h.consumer.routingRows()[0].id
  const stale = limits.observe(route)
  limits.mark(stale, {
    scope: { kind: 'pool' },
    mergeLaw: 'overwrite',
    cause: 'rate-limit',
    until: Date.now() - 1,
  })
  await limits.flush()
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    limits: async () => limits,
    fetch: async () => new Response('recovered'),
  })
  expect((await fetch('https://fixture.invalid', { headers })).status).toBe(200)
  expect(await limits.beforeDispatch(route)).toBe(true)
  limits.mark(stale, {
    scope: { kind: 'pool' },
    mergeLaw: 'overwrite',
    cause: 'rate-limit',
    until: Date.now() + 240000,
  })
  await limits.flush()
  expect((await limits.marks()).has(route)).toBe(false)
  expect(
    (await readVaultRoster(h.hub.rosterPath('fixture-a')))?.limits,
  ).toMatchObject({ tombstones: [expect.any(Object)] })
})

test('failover does not await timed mark publication', async () => {
  const h = await harness([row('a'), row('b')])
  const limits = await h.limits('fixture-a')
  let sends = 0
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    limits: async () => limits,
    fetch: async () => {
      if (++sends === 2) {
        expect(
          (await readVaultRoster(h.hub.rosterPath('fixture-a')))?.limits,
        ).toBeUndefined()
      }
      return new Response('reply', { status: sends === 1 ? 429 : 200 })
    },
  })
  expect((await fetch('https://fixture.invalid', { headers })).status).toBe(200)
  expect(sends).toBe(2)
})
