import { afterAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import { markFromSignal, statusVaultOrder } from '@cortexkit/common-auth/limits'
import { createFetch } from '../src/fetch.js'
import { createAccountLimits, limitFromReply } from '../src/limits.js'
import { fixtureEntries } from '../test-entry.ts'
import { harness, row } from './fakes.ts'

// Transport-level adoption vectors: the parser sees HTTP replies, never a
// fixture-built signal. The complementary file exercises the OC2 coordinator.
const covered = new Set<number>()
const ids = [
  1, 2, 3, 4, 5, 6, 7, 10, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26,
  27, 38, 39, 40, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  57, 60, 61, 62, 63, 64, 65, 66,
]
type Host = 'opencode1' | 'pi'
function vector(
  id: number,
  name: string,
  check: (host: Host) => Promise<void>,
) {
  test(`CL-${id} ${name}`, async () => {
    for (const host of ['opencode1', 'pi'] as const) await check(host)
    covered.add(id)
  })
}
afterAll(() => expect([...covered].sort((a, b) => a - b)).toEqual(ids))

const placeholder = 'fixture-owned'
const headers = { authorization: `Bearer ${placeholder}` }
const credits = '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}'
const cap = '{"error":{"metadata":{"limit_source":"openrouter_key_limit"}}}'
const quota = '{"error":"claustrum-auth: accounts-rate-limited"}'
const payment = '{"error":"claustrum-auth: insufficient balance"}'
function reply(status: number, retry?: string, body = `provider-${status}`) {
  return new Response(body, {
    status,
    headers: retry === undefined ? {} : { 'retry-after': retry },
  })
}
async function world(
  host: Host,
  service = 'fixture-a',
  rows = [row('a'), row('b')],
) {
  let time = 1000
  const h = await harness(rows, host, () => time)
  const queued: Response[] = []
  const wire: Request[] = []
  let transport = async (request: Request) => {
    wire.push(request)
    return queued.shift() ?? reply(200, undefined, 'served B')
  }
  const fetch = createFetch({
    entry: { ...fixtureEntries[0], service },
    placeholder,
    consumer: h.consumer,
    host,
    now: () => time,
    limits: () => h.limits('fixture-a'),
    fetch: async (request) => transport(request as Request),
  })
  return {
    h,
    queued,
    wire,
    fetch,
    host,
    setTime(value: number) {
      time = value
    },
    transport(value: typeof transport) {
      transport = value
    },
    send(url = 'https://fixture.invalid/v1', model = 'model-a') {
      return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model }),
      })
    },
    limits: () => h.limits('fixture-a'),
    async blockers(index = 0) {
      return (
        (await (await h.limits('fixture-a')).candidates())[index]?.blockers ??
        []
      )
    },
  }
}
type World = Awaited<ReturnType<typeof world>>
async function markReply(
  w: World,
  status: number,
  retry?: string,
  body?: string,
) {
  w.queued.push(reply(status, retry, body))
  return w.send()
}
async function saved(w: World) {
  await (await w.limits()).flush()
  return (await readVaultRoster(w.h.hub.rosterPath('fixture-a')))?.limits
}

vector(
  1,
  'HTTP numeric hint marks seventeen seconds and reroutes without waiting',
  async (host) => {
    const w = await world(host)
    expect((await markReply(w, 429, '17')).status).toBe(200)
    expect(await w.blockers()).toEqual([
      { kind: 'hard', until: 18000, cause: 'rate-limit' },
    ])
    expect(w.h.reads).toEqual(['a', 'b'])
  },
)
vector(
  2,
  'HTTP zero expires immediately, not at the default minute',
  async (host) => {
    const w = await world(host)
    await markReply(w, 429, '0')
    expect(await w.blockers()).toEqual([])
    await w.send()
    expect(w.h.reads).toEqual(['a', 'b', 'a'])
  },
)
vector(3, 'core HTTP dates remain absolute', async (host) => {
  const w = await world(host)
  await markReply(w, 429, 'Thu, 01 Jan 1970 00:00:18 GMT')
  expect(await w.blockers()).toMatchObject([{ until: 18000 }])
})
vector(
  4,
  'absent blank invalid and nonfuture dates default to one minute',
  async (host) => {
    for (const value of [
      undefined,
      '',
      'invalid',
      'Thu, 01 Jan 1970 00:00:01 GMT',
      'Thu, 01 Jan 1970 00:00:00 GMT',
    ]) {
      const w = await world(host)
      await markReply(w, 429, value)
      expect(await w.blockers()).toMatchObject([{ until: 61000 }])
    }
  },
)
vector(
  5,
  'body quota and generic reset headers do not extend status-only marks',
  async (host) => {
    const w = await world(host)
    w.queued.push(
      new Response('{"resetAt":7201000}', {
        status: 429,
        headers: {
          'retry-after-ms': '180000',
          'x-ratelimit-reset-requests': '2h',
        },
      }),
    )
    await w.send()
    expect(await w.blockers()).toMatchObject([{ until: 61000 }])
  },
)
vector(
  6,
  '401 reports the served receipt but does not mark quota',
  async (host) => {
    const w = await world(host)
    await markReply(w, 401)
    expect(await w.blockers()).toEqual([])
    expect(w.h.reports).toHaveLength(1)
  },
)
vector(
  7,
  'unconfirmed 402 and 403 pass without quota or advance',
  async (host) => {
    for (const status of [402, 403]) {
      const w = await world(host)
      const response = await markReply(w, status, '17', 'original secret-a-1')
      expect(response.status).toBe(status)
      expect(await response.text()).toContain('original')
      expect(w.h.reads).toEqual(['a'])
      expect(await w.blockers()).toEqual([])
    }
  },
)

async function concurrentOverwrite(
  host: Host,
  firstStatus: number,
  secondStatus: number,
  retry?: string,
) {
  const w = await world(host, 'deepseek')
  const limits = await w.limits()
  const observation = limits.observe(w.h.consumer.routingRows()[0].id)
  await markReply(w, firstStatus, '120')
  // Custody serializes this consumer's sends. Replay a reply another process
  // could already have in flight through the real parser and registry instead.
  const response = reply(secondStatus, retry)
  const parsed = await limitFromReply({
    account: observation.binding.account,
    service: 'deepseek',
    status: response.status,
    headers: response.headers,
    body: () => response.clone().text(),
    now: 1000,
  })
  const mark = markFromSignal(parsed, statusVaultOrder.markers[host], {
    now: 1000,
  })
  if (!mark) throw new Error('Expected overwritten mark')
  limits.mark(observation, mark, 1000)
  await saved(w)
  return w
}
vector(
  10,
  'a second in-flight response overwrites a longer mark, including zero',
  async (host) => {
    for (const [hint, until] of [
      ['17', 18000],
      ['0', undefined],
      [undefined, 61000],
    ] as const) {
      const w = await concurrentOverwrite(host, 429, 429, hint)
      expect((await w.blockers())[0]?.until).toBe(until)
    }
  },
)
vector(12, 'deadline equality admits the account', async (host) => {
  const w = await world(host)
  await markReply(w, 429, '17')
  w.setTime(17999)
  await w.send()
  w.setTime(18000)
  await w.send()
  w.setTime(18001)
  await w.send()
  expect(w.h.reads).toEqual(['a', 'b', 'b', 'a', 'a'])
})
vector(
  13,
  'zero-expiry marks do not reset the request-local tried set',
  async (host) => {
    const w = await world(host)
    w.queued.push(reply(429, '0'), reply(429, '0'))
    expect((await w.send()).status).toBe(429)
    expect(w.h.reads).toEqual(['a', 'b'])
    await w.send()
    expect(w.h.reads.at(-1)).toBe('a')
  },
)
vector(
  14,
  'B success leaves A marked for the next model request',
  async (host) => {
    const w = await world(host)
    await markReply(w, 429, '120')
    await w.send(undefined, 'model-b')
    expect(w.h.reads).toEqual(['a', 'b', 'b'])
    expect(await w.blockers()).toMatchObject([{ until: 121000 }])
  },
)
vector(
  15,
  'same-roster owners share marks while another provider stays isolated',
  async (host) => {
    const w = await world(host, 'fixture-a', [
      row('a'),
      row('other', { providerIds: ['fixture-b'] }),
    ])
    await markReply(w, 429, '120')
    const peer = await createAccountLimits({
      provider: 'fixture-a',
      path: w.h.hub.rosterPath('fixture-a'),
      consumer: w.h.consumer,
      now: () => 1000,
    })
    try {
      expect([...(await peer.marks())].map(([, until]) => until)).toEqual([
        121000,
      ])
      expect([...(await (await w.h.limits('fixture-b')).marks())]).toEqual([])
      expect(await saved(w)).toMatchObject({ marks: [expect.any(Object)] })
    } finally {
      await peer.dispose()
    }
  },
)

for (const [id, status] of [
  [18, 429],
  [19, 401],
] as const)
  vector(
    id,
    `vault-order ${status} advances to the second account`,
    async (host) => {
      const w = await world(host)
      await markReply(w, status, '7200')
      expect(w.h.reads).toEqual(status === 401 ? ['a', 'a', 'b'] : ['a', 'b'])
      expect((await w.blockers()).length).toBe(status === 429 ? 1 : 0)
    },
  )
for (const [id, status] of [
  [20, 429],
  [21, 401],
] as const)
  vector(
    id,
    `the last provider ${status} is readable and redacted`,
    async (host) => {
      const w = await world(host)
      w.queued.push(
        reply(status, '17', 'first secret-a-1'),
        reply(status, '17', 'last secret-b-1'),
      )
      const response = await w.send()
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('last [credential]')
      expect(response.headers.get('retry-after')).toBe('17')
    },
  )
vector(
  22,
  'earlier 429 survives terminal 401 even after timer expiry',
  async (host) => {
    for (const hint of ['17', '0']) {
      const w = await world(host)
      w.queued.push(reply(429, hint), reply(401))
      const response = await w.send()
      expect(await response.text()).toBe(quota)
      expect(response.headers.get('retry-after')).toBe(
        hint === '0' ? '60' : '17',
      )
    }
  },
)
vector(
  23,
  'a fresh all-marked request uses the earliest deadline without vault reads',
  async (host) => {
    const w = await world(host)
    w.queued.push(reply(429, '17'), reply(429, '8'))
    await w.send()
    const reads = w.h.reads.length
    const response = await w.send()
    expect(response.status).toBe(429)
    expect(await response.text()).toBe(quota)
    expect(response.headers.get('retry-after')).toBe('8')
    expect(w.h.reads).toHaveLength(reads)
  },
)
vector(
  24,
  'synthetic retry metadata has a one-second floor and minute fallback',
  async (host) => {
    for (const [hint, retry] of [
      ['0.25', '1'],
      ['1.25', '2'],
      ['0', '60'],
    ]) {
      const w = await world(host)
      w.queued.push(reply(429, hint), reply(401))
      const response = await w.send()
      expect(await response.text()).toBe(quota)
      expect(response.headers.get('retry-after')).toBe(retry)
    }
  },
)
vector(
  25,
  'an initial successful SSE limit event does not enter the core loop',
  async (host) => {
    const w = await world(host)
    w.queued.push(
      new Response(
        'data: {"type":"error","status":429,"message":"secret-a-1"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const response = await w.send()
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('secret-a-1')
    expect(w.h.reads).toEqual(['a'])
    expect(await w.blockers()).toEqual([])
  },
)
vector(
  26,
  'post-return stream limits remain with the host without replay',
  async (host) => {
    const w = await world(host)
    w.queued.push(
      new Response('data: {"text":"output"}\n\ndata: {"status":429}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    expect(await (await w.send()).text()).toContain('output')
    expect(w.h.reads).toEqual(['a'])
    expect(await w.blockers()).toEqual([])
  },
)
vector(
  27,
  'an empty roster is a custody failure rather than quota',
  async (host) => {
    const w = await world(host, 'fixture-a', [])
    await expect(w.send()).rejects.toMatchObject({ code: 'no-vault-account' })
    expect(w.h.reads).toEqual([])
  },
)
vector(
  38,
  'exact-origin and URL-credential refusals happen before a vault read',
  async (host) => {
    for (const url of [
      'http://fixture.invalid/v1',
      'https://fixture.invalid:444/v1',
      'https://fixture.invalid.evil/v1',
      'https://user@fixture.invalid/v1',
    ]) {
      const w = await world(host)
      await expect(w.send(url)).rejects.toMatchObject({
        code: 'origin-refused',
      })
      expect(w.h.reads).toEqual([])
      expect(w.wire).toEqual([])
      expect(await w.blockers()).toEqual([])
    }
  },
)
vector(
  39,
  'redirect then 429 marks A but failover restarts from the original URL',
  async (host) => {
    const w = await world(host)
    w.queued.push(
      new Response(null, { status: 307, headers: { location: '/redirected' } }),
      reply(429, '17'),
    )
    expect((await w.send()).status).toBe(200)
    expect(w.wire.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1',
      '/redirected',
      '/v1',
    ])
    expect(w.h.reads).toEqual(['a', 'a', 'b'])
  },
)
vector(
  40,
  'cross-origin and bearer-echo redirects stay redacted without failover',
  async (host) => {
    for (const location of ['https://elsewhere.invalid/v1', '/secret-a-1']) {
      const w = await world(host)
      w.queued.push(new Response(null, { status: 307, headers: { location } }))
      const response = await w.send()
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).not.toContain('secret-a-1')
      expect(w.wire).toHaveLength(1)
      expect(await w.blockers()).toEqual([])
    }
  },
)

for (const [id, service, body] of [
  [42, 'deepseek', 'Insufficient Balance'],
  [43, 'openrouter', credits],
] as const)
  vector(
    id,
    `${service} balance reply marks five minutes and advances`,
    async (host) => {
      const w = await world(host, service)
      expect((await markReply(w, 402, undefined, body)).status).toBe(200)
      expect(await w.blockers()).toEqual([
        { kind: 'hard', until: 301000, cause: 'payment-balance' },
      ])
      expect(w.h.reads).toEqual(['a', 'b'])
      expect(w.h.reports).toEqual([])
    },
  )
for (const [id, service, bodies] of [
  [
    44,
    'openrouter',
    [
      cap,
      '{"error":{"metadata":{"limit_source":"openrouter_in_flight_budget"}}}',
    ],
  ],
  [
    45,
    'openrouter',
    [
      '{"error":{"metadata":{"limit_source":"openrouter_credits","reason":"weight_exceeds_budget"}}}',
      '{"error":{"message":"Insufficient credits"}}',
      'not JSON',
    ],
  ],
  [46, 'xai', [credits]],
] as const)
  vector(
    id,
    `${service} unconfirmed payment replies do not mark or advance`,
    async (host) => {
      for (const body of bodies) {
        const w = await world(host, service)
        const response = await markReply(w, 402, '17', body)
        expect(response.status).toBe(402)
        expect(await response.text()).toBe(body)
        expect(w.h.reads).toEqual(['a'])
        expect(await w.blockers()).toEqual([])
        expect(w.h.reports).toEqual([])
      }
    },
  )
for (const [id, statuses] of [
  [47, [402, 429]],
  [48, [429, 402]],
] as const)
  vector(
    id,
    'mixed payment and rate attempts synthesize the existing quota refusal',
    async (host) => {
      const w = await world(host, 'deepseek')
      w.queued.push(...statuses.map((status) => reply(status, '17')))
      const response = await w.send()
      expect(response.status).toBe(429)
      expect(await response.text()).toBe(quota)
      expect(response.headers.get('retry-after')).toBe('17')
      expect(w.h.reports).toEqual([])
    },
  )
vector(
  49,
  'two attempted balance failures preserve the last provider body',
  async (host) => {
    const w = await world(host, 'deepseek')
    w.queued.push(reply(402, '17', 'first'), reply(402, '17', 'last'))
    const response = await w.send()
    expect(response.status).toBe(402)
    expect(await response.text()).toBe('last')
  },
)
vector(
  50,
  'auth and balance in either order preserve the last provider response',
  async (host) => {
    for (const statuses of [
      [401, 402],
      [402, 401],
    ]) {
      const w = await world(host, 'deepseek')
      w.queued.push(...statuses.map((status) => reply(status, '17')))
      const response = await w.send()
      expect(response.status).toBe(statuses[1])
      expect(await response.text()).toBe(`provider-${statuses[1]}`)
      expect(w.h.reports).toHaveLength(1)
    }
  },
)
vector(
  51,
  'a key-cap reply after 429 is not mistaken for confirmed balance',
  async (host) => {
    const w = await world(host, 'openrouter')
    w.queued.push(reply(429, '17'), reply(402, undefined, cap))
    const response = await w.send()
    expect(response.status).toBe(402)
    expect(await response.text()).toBe(cap)
    expect(await w.blockers(1)).toEqual([])
  },
)
vector(
  52,
  'balance hints and overflowing milliseconds use finite defaults',
  async (host) => {
    for (const [hint, until] of [
      [undefined, 301000],
      ['invalid', 301000],
      ['7200', 7201000],
      ['17', 18000],
      ['Thu, 01 Jan 1970 00:00:11 GMT', 11000],
      ['0', undefined],
      ['1e308', 301000],
    ] as const) {
      const w = await world(host, 'deepseek')
      await markReply(w, 402, hint)
      expect((await w.blockers())[0]?.until).toBe(until)
      if (until !== undefined)
        expect((await w.blockers())[0]?.cause).toBe('payment-balance')
    }
  },
)
vector(
  53,
  'a sole balance-marked account names payment without a provider send',
  async (host) => {
    const w = await world(host, 'deepseek', [row('a')])
    await markReply(w, 402)
    w.setTime(2000)
    const response = await w.send()
    expect(response.status).toBe(402)
    expect(await response.text()).toBe(payment)
    expect([...response.headers]).toEqual([
      ['content-type', 'application/json'],
      ['retry-after', '299'],
    ])
    expect(w.h.reads).toEqual(['a'])
  },
)
vector(
  54,
  'registry restart preserves payment cause, never provider text or credentials',
  async (host) => {
    const w = await world(host, 'deepseek', [row('a')])
    await markReply(w, 402, undefined, 'Insufficient Balance secret-a-1')
    const state = await saved(w)
    expect(JSON.stringify(state)).not.toContain('Insufficient Balance')
    expect(JSON.stringify(state)).not.toContain('secret-a-1')
    expect(state).toMatchObject({
      marks: [{ entries: [{ until: 301000, cause: 'payment-balance' }] }],
    })
    await w.h.disposeLimits()
    const script = `
      import { readVaultRoster, vaultRoutingRows } from '@cortexkit/common-auth/claustrum';
      import { createAccountLimits } from ${JSON.stringify(new URL('../src/limits.ts', import.meta.url).href)};
      import { createFetch } from ${JSON.stringify(new URL('../src/fetch.ts', import.meta.url).href)};
      import { fixtureEntries } from ${JSON.stringify(new URL('../test-entry.ts', import.meta.url).href)};
      const path = process.argv[1];
      const roster = await readVaultRoster(path);
      const consumer = { snapshot: () => roster, routingRows: () => vaultRoutingRows(roster) };
      const limits = await createAccountLimits({ provider: 'fixture-a', path, consumer, now: () => 2000 });
      const send = createFetch({ entry: { ...fixtureEntries[0], service: 'deepseek' },
        placeholder: 'owned', consumer, limits: async () => limits, now: () => 2000,
        fetch: async () => { throw new Error('must not dispatch'); } });
      const response = await send('https://fixture.invalid/v1', { headers: { authorization: 'Bearer owned' } });
      console.log(JSON.stringify({ status: response.status, body: await response.text(), retry: response.headers.get('retry-after') }));
      await limits.dispose();
    `
    const child = Bun.spawn(
      [process.execPath, '--eval', script, w.h.hub.rosterPath('fixture-a')],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, error }).toEqual({ exit: 0, error: '' })
    expect(JSON.parse(output)).toEqual({
      status: 402,
      body: payment,
      retry: '299',
    })
    w.setTime(2000)
    const response = await w.send()
    expect(await response.text()).toBe(payment)
    expect(response.headers.get('retry-after')).toBe('299')
    expect(w.h.reads).toEqual(['a'])
  },
)

async function recovery(host: Host, at: number, status = 200) {
  const w = await world(host, 'openrouter')
  const old = await w.limits()
  const route = w.h.consumer.routingRows()[0].id
  const observation = old.observe(route)
  await markReply(w, 402, undefined, credits)
  await saved(w)
  await w.h.disposeLimits()
  w.setTime(at)
  const response = await markReply(
    w,
    status,
    undefined,
    status === 402 ? cap : 'topped up',
  )
  expect(response.status).toBe(status)
  expect(w.h.reads).toEqual(['a', 'b', 'a'])
  const current = await w.limits()
  expect(await current.beforeDispatch(route)).toBe(true)
  const delayedReply = reply(402, '7200', credits)
  const parsed = await limitFromReply({
    account: observation.binding.account,
    service: 'openrouter',
    status: delayedReply.status,
    headers: delayedReply.headers,
    body: () => delayedReply.clone().text(),
    now: 1000,
  })
  const mark = markFromSignal(parsed, statusVaultOrder.markers[host], {
    now: 1000,
  })
  if (!mark) throw new Error('Expected delayed balance evidence')
  current.mark(observation, mark, 1000)
  await current.flush()
  expect(await w.blockers()).toEqual([])
  expect(await saved(w)).toMatchObject({
    tombstones: expect.arrayContaining([expect.any(Object)]),
  })
}
vector(
  55,
  'exact expiry probes A and clears with a tombstone before its next dispatch',
  async (host) => {
    await recovery(host, 301000)
  },
)
vector(
  56,
  'an expired probe that is still out of balance renews five minutes',
  async (host) => {
    const w = await world(host, 'deepseek')
    await markReply(w, 402)
    w.setTime(301001)
    await markReply(w, 402)
    expect(w.h.reads).toEqual(['a', 'b', 'a', 'b'])
    expect(await w.blockers()).toMatchObject([
      { until: 601001, cause: 'payment-balance' },
    ])
  },
)
vector(
  57,
  'a key-cap response to an expired balance probe passes and clears balance only',
  async (host) => {
    await recovery(host, 301001, 402)
  },
)
vector(
  60,
  'overwrite persists deadline and cause together, including zero',
  async (host) => {
    for (const [first, second, hint, until, cause] of [
      [402, 429, '17', 18000, 'rate-limit'],
      [402, 429, '0', undefined, undefined],
      [429, 402, undefined, 301000, 'payment-balance'],
    ] as const) {
      const w = await concurrentOverwrite(host, first, second, hint)
      expect((await w.blockers())[0]?.until).toBe(until)
      expect((await w.blockers())[0]?.cause).toBe(cause)
    }
  },
)
vector(
  61,
  'unconfirmed payment body and headers cannot echo the served key',
  async (host) => {
    const w = await world(host, 'openrouter')
    w.queued.push(
      new Response(
        '{"error":{"message":"secret-a-1","metadata":{"limit_source":"openrouter_key_limit"}}}',
        { status: 402, headers: { 'x-echo': 'secret-a-1' } },
      ),
    )
    const response = await w.send()
    expect(response.status).toBe(402)
    expect(await response.text()).not.toContain('secret-a-1')
    expect(response.headers.get('x-echo')).not.toContain('secret-a-1')
    expect(await w.blockers()).toEqual([])
    expect(w.h.reports).toEqual([])
  },
)
vector(
  62,
  'every account balance-marked refuses payment at the earliest deadline',
  async (host) => {
    const w = await world(host, 'deepseek')
    w.queued.push(reply(402), reply(402, '17.001'))
    await w.send()
    w.setTime(2000)
    const response = await w.send()
    expect(response.status).toBe(402)
    expect(await response.text()).toBe(payment)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(w.h.reads).toEqual(['a', 'b'])
  },
)
async function legacyMark(w: World, index: number) {
  const limits = await w.limits()
  const route = w.h.consumer.routingRows()[index].id
  const observation = limits.observe(route)
  const response = reply(429, '300')
  const signal = await limitFromReply({
    account: observation.binding.account,
    service: 'fixture-a',
    status: response.status,
    headers: response.headers,
    now: 1000,
  })
  const mark = markFromSignal(signal, statusVaultOrder.markers[w.host], {
    now: 1000,
  })
  if (!mark) throw new Error('Expected rate evidence')
  // Old persisted entries have a deadline but no typed cause. Strip only that
  // optional field from parsed reply evidence to exercise the legacy boundary.
  limits.mark(observation, { ...mark, cause: undefined }, 1000)
  await limits.flush()
}
vector(
  63,
  'mixed balance and rate or unknown causes retain quota wording',
  async (host) => {
    for (const legacy of [false, true]) {
      const w = await world(host, 'deepseek')
      if (legacy) await legacyMark(w, 1)
      w.queued.push(reply(402), ...(legacy ? [] : [reply(429, '300')]))
      await w.send()
      w.setTime(2000)
      const response = await w.send()
      expect(response.status).toBe(429)
      expect(await response.text()).toBe(quota)
      expect(response.headers.get('retry-after')).toBe('299')
    }
  },
)
vector(
  64,
  'a sole rate or legacy mark does not acquire a payment cause',
  async (host) => {
    for (const legacy of [false, true]) {
      const w = await world(host, 'fixture-a', [row('a')])
      if (legacy) await legacyMark(w, 0)
      else await markReply(w, 429, '300')
      const response = await w.send()
      expect(response.status).toBe(429)
      expect(await response.text()).toBe(quota)
    }
  },
)
vector(
  65,
  'nonroutable inventory rows do not change the payment-eligible count',
  async (host) => {
    for (const extra of [
      row('b', { state: 'inactive' }),
      row('b', { providerIds: ['fixture-b'] }),
    ]) {
      const w = await world(host, 'deepseek', [row('a'), extra])
      await markReply(w, 402)
      expect(await (await w.send()).text()).toBe(payment)
      expect(w.h.reads).toEqual(['a'])
      w.setTime(301000)
      expect((await w.send()).status).toBe(200)
    }
  },
)
vector(
  66,
  'a fresh owner after expiry fences delayed balance writers on recovery',
  async (host) => {
    await recovery(host, 301001)
  },
)
