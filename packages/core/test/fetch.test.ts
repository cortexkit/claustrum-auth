import { expect, test } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  createFetch,
  fixtureEntries,
  maxBodyBytes,
  orderedRoutes,
  servingCallbacks,
} from '../test-entry.ts'
import { bearer, harness, placeholder, row } from './fakes.ts'

const balanceEntry = { ...fixtureEntries[0], service: 'deepseek' }

test('never report not-mine or refused rows through either core serving path', async () => {
  const excluded = [
    row('chatgpt', { authMethod: 'chatgpt' }),
    row('antigravity', { authMethod: 'antigravity' }),
    row('anthropic-oauth', {
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'anthropic',
    }),
    ...[
      'openai',
      'openai-codex',
      'anthropic',
      'anthropic-platform',
      'google',
    ].map((id) => row(id, { providerIds: [id] })),
    row('missing-method', { authMethod: undefined }),
    row('unmapped', { providerIds: [] }),
    row('unsupported', { providerIds: ['unknown'] }),
    row('mixed', { providerIds: ['fixture-a', 'fixture-b'] }),
    row('old-client', { providerIds: undefined, authMethod: undefined }),
  ]
  for (const host of ['opencode1', 'pi', 'opencode2'] as const) {
    const h = await harness(excluded, host)
    for (const value of excluded)
      await expect(h.consumer.authorize(value.id)).rejects.toMatchObject({
        kind: 'route-unavailable',
      })
    const options = {
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
    }
    const callbacks = servingCallbacks(options)
    let sends = 0
    const fetch = createFetch({
      ...options,
      fetch: async () => {
        sends++
        return new Response('provider-401', { status: 401 })
      },
    })
    await expect(
      fetch('https://fixture.invalid', { headers: bearer }),
    ).rejects.toMatchObject({ code: 'no-vault-account' })
    await expect(
      callbacks.request(
        new URL('https://fixture.invalid'),
        new Headers(bearer),
      ),
    ).rejects.toMatchObject({ code: 'no-vault-account' })
    const foreign = new Response('foreign-401', { status: 401 })
    expect(await callbacks.response(undefined, foreign)).toBe(foreign)
    const forged = {
      credentialId: 'openai',
      accessToken: 'forged',
      recordVersion: 1,
    } as ClaustrumScopedAttempt
    await expect(
      h.consumer.reportFailure(forged, 401, 'direct'),
    ).rejects.toMatchObject({ kind: 'no-receipt' })
    await expect(
      callbacks.response(
        { receipt: forged, route: 'openai' },
        new Response('401', { status: 401 }),
      ),
    ).rejects.toThrow('Claustrum dispatch receipt has no active owner')
    expect(h.reports).toEqual([])
    expect(h.reads).toEqual([])
    expect(sends).toBe(0)
  }
})

test('served receipts alone report 401 and never 402 429 or 5xx', async () => {
  const h = await harness()
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
  }
  const callbacks = servingCallbacks(options)
  for (const status of [402, 429, 500, 401]) {
    const holder = await callbacks.request(
      new URL('https://fixture.invalid'),
      new Headers(bearer),
    )
    await callbacks.response(holder, new Response('error', { status }))
  }
  expect(h.reports).toHaveLength(1)
  expect(h.reports[0]).toMatchObject({
    credentialId: 'a',
    recordVersion: 1,
    providerStatus: 401,
  })
})

test('redaction scrubs JSON SSE Location and thrown transport errors on both paths', async () => {
  const h = await harness()
  const secret = 'secret-a-1'
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
  }
  const providers = [
    () => Response.json({ error: secret }, { status: 400 }),
    () =>
      new Response(
        `event: error\ndata: {"error":{"message":"${secret}"}}\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'x-echo': secret } },
      ),
    () =>
      new Response('redirect', {
        status: 307,
        headers: {
          location: `https://other.invalid/${secret}`,
          'x-echo': secret,
        },
      }),
  ]
  for (const provider of providers) {
    const fetch = createFetch({ ...options, fetch: async () => provider() })
    const response = await fetch('https://fixture.invalid', { headers: bearer })
    expect(await response.text()).not.toContain(secret)
    expect([...response.headers.values()].join(' ')).not.toContain(secret)
    const callbacks = servingCallbacks(options)
    const holder = await callbacks.request(
      new URL('https://fixture.invalid'),
      new Headers(bearer),
    )
    const other = await callbacks.response(holder, provider())
    expect(await other.text()).not.toContain(secret)
    expect([...other.headers.values()].join(' ')).not.toContain(secret)
  }
  const fetch = createFetch({
    ...options,
    fetch: async () => {
      throw new Error(`transport ${secret}`)
    },
  })
  try {
    await fetch('https://fixture.invalid', { headers: bearer })
    throw new Error('expected rejection')
  } catch (error) {
    expect(String(error)).toContain('transport')
    expect(String(error)).not.toContain(secret)
  }
})

test('ordered routing admits OAuth without quota in roster order and skips marks', async () => {
  const h = await harness([
    row('b', {
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'fixture-a',
    }),
    row('a'),
  ])
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    now: () => 1000,
    rateLimitMarks: new Map<string, number>(),
  }
  const rows = h.consumer.routingRows()
  expect(rows).toHaveLength(2)
  expect(orderedRoutes(options)).toEqual(rows.map((r) => r.id))
  options.rateLimitMarks.set(rows[0].id, 2000)
  expect(orderedRoutes(options)).toEqual([rows[1].id])
  options.rateLimitMarks.set(rows[0].id, 999)
  expect(orderedRoutes(options)).toHaveLength(2)
})

test('stream body replays across 429 accounts and 401 rotation with fresh physical reads', async () => {
  const h = await harness([row('a'), row('b')])
  const bodies: string[] = []
  const auth: string[] = []
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async (input) => {
      const request = input as Request
      bodies.push(await request.text())
      auth.push(request.headers.get('authorization') ?? '')
      if (auth.length === 1)
        return new Response('first-limited', { status: 429 })
      if (auth.length === 2) {
        h.setVersion(2)
        return new Response('rotated', { status: 401 })
      }
      return new Response('success')
    },
  })
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('stream-body'))
      controller.close()
    },
  })
  expect(
    await (
      await fetch('https://fixture.invalid', {
        method: 'POST',
        body: stream,
        headers: bearer,
        duplex: 'half',
      } as RequestInit)
    ).text(),
  ).toBe('success')
  expect(bodies).toEqual(['stream-body', 'stream-body', 'stream-body'])
  expect(auth).toEqual([
    'Bearer secret-a-1',
    'Bearer secret-b-1',
    'Bearer secret-b-2',
  ])
  expect(h.reads).toEqual(['a', 'b', 'b'])
  expect(h.reports).toEqual([])
})

for (const [label, statuses, expectedStatus, lastBody] of [
  ['all 402', [402, 402], 402, 'last'],
  ['401 then 402', [401, 402], 402, 'last'],
  ['402 then 401', [402, 401], 401, 'last'],
  ['402 then 429', [402, 429], 429, 'accounts-rate-limited'],
  ['429 then 402', [429, 402], 429, 'accounts-rate-limited'],
  ['all 429', [429, 429], 429, 'last'],
  ['all 401', [401, 401], 401, 'last'],
  ['429 then 401', [429, 401], 429, 'accounts-rate-limited'],
  ['401 then 429', [401, 429], 429, 'last'],
] as const) {
  test(`exhaustion ${label} returns readable redacted body and cancels only discarded responses`, async () => {
    const h = await harness([row('a'), row('b')])
    const cancellations = [0, 0]
    let sends = 0
    const fetch = createFetch({
      entry: balanceEntry,
      placeholder,
      consumer: h.consumer,
      now: () => 1000,
      fetch: async () => {
        const i = sends++
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    error: `${i ? 'last' : 'first'} secret-${i ? 'b' : 'a'}-1`,
                  }),
                ),
              )
              c.close()
            },
            cancel() {
              cancellations[i] = cancellations[i] + 1
            },
          }),
          {
            status: statuses[i],
            headers: {
              'retry-after': '17',
              'content-type': 'application/json',
            },
          },
        )
      },
    })
    const response = await fetch('https://fixture.invalid', { headers: bearer })
    expect(response.status).toBe(expectedStatus)
    const text = JSON.stringify(await response.json())
    expect(text).toContain(lastBody)
    expect(text).not.toContain('secret-')
    expect(response.headers.get('retry-after')).toBe('17')
    expect(cancellations).toEqual([
      1,
      lastBody === 'accounts-rate-limited' ? 1 : 0,
    ])
    expect(sends).toBe(2)
    if (label.includes('402'))
      expect(
        h.reports.map(({ credentialId, providerStatus }) => ({
          credentialId,
          providerStatus,
        })),
      ).toEqual(
        statuses.flatMap((status, index) =>
          status === 401
            ? [{ credentialId: index ? 'b' : 'a', providerStatus: 401 }]
            : [],
        ),
      )
  })
}

test('all marked accounts synthesize a readable 429 with earliest retry-after and no reads', async () => {
  const h = await harness([row('a'), row('b')])
  const ids = h.consumer.routingRows().map((r) => r.id)
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    now: () => 1000,
    rateLimitMarks: new Map([
      [ids[0], 18000],
      [ids[1], 9000],
    ]),
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  const response = await fetch('https://fixture.invalid', { headers: bearer })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('8')
  expect(await response.json()).toEqual({
    error: 'claustrum-auth: accounts-rate-limited',
  })
  expect(h.reads).toEqual([])
})

test('manual redirect chain replays 307 and 308 and drops POST for 301 302 and 303', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const h = await harness()
    const bodies: string[] = []
    const methods: string[] = []
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      fetch: async (input) => {
        const request = input as Request
        expect(request.redirect).toBe('manual')
        expect(request.headers.get('authorization')).toBe('Bearer secret-a-1')
        bodies.push(await request.text())
        methods.push(request.method)
        return bodies.length < 3
          ? new Response('redirect', { status, headers: { location: '/next' } })
          : new Response('done')
      },
    })
    expect(
      await (
        await fetch('https://fixture.invalid/start', {
          headers: bearer,
          method: 'POST',
          body: 'same-body',
        })
      ).text(),
    ).toBe('done')
    expect(methods).toEqual([
      'POST',
      ...([307, 308].includes(status) ? ['POST', 'POST'] : ['GET', 'GET']),
    ])
    expect(bodies).toEqual([
      'same-body',
      ...([307, 308].includes(status) ? ['same-body', 'same-body'] : ['', '']),
    ])
    expect(h.reads).toHaveLength(3)
  }
})

test('cross-origin redirects and bearer echoes are returned without following and redirect loops stop at five', async () => {
  const h = await harness()
  for (const location of [
    'https://other.invalid/steal',
    'https://fixture.invalid/echo?key=secret-a-1',
  ]) {
    let sends = 0
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      fetch: async () => {
        sends++
        return new Response('redirect', { status: 307, headers: { location } })
      },
    })
    const response = await fetch('https://fixture.invalid', { headers: bearer })
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).not.toContain('secret-a-1')
    expect(sends).toBe(1)
  }
  let sends = 0
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => {
      sends++
      return new Response('loop', {
        status: 302,
        headers: { location: '/again' },
      })
    },
  })
  await expect(
    fetch('https://fixture.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'redirect-limit' })
  expect(sends).toBe(6)
})

test('abort during a dispatch ends failover without marking an account', async () => {
  const h = await harness([row('a'), row('b')])
  const controller = new AbortController()
  const marks = new Map<string, number>()
  let sends = 0
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    rateLimitMarks: marks,
    fetch: async (input) => {
      sends++
      controller.abort()
      expect((input as Request).signal.aborted).toBe(true)
      return new Response('limited', { status: 429 })
    },
  })
  await expect(
    fetch('https://fixture.invalid', {
      headers: bearer,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(sends).toBe(1)
  expect(marks.size).toBe(0)
})

test('body limit refuses before any vault read', async () => {
  const h = await harness()
  let cancelled = false
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(maxBodyBytes + 1))
      c.enqueue(new Uint8Array(1))
      c.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => new Response(),
  })
  await expect(
    fetch('https://fixture.invalid', {
      method: 'POST',
      body: stream,
      headers: bearer,
      duplex: 'half',
    } as RequestInit),
  ).rejects.toMatchObject({ code: 'body-too-large' })
  expect(cancelled).toBe(true)
  expect(h.reads).toEqual([])
})

test('abort while buffering cancels the stream before any vault read', async () => {
  const h = await harness()
  const controller = new AbortController()
  let cancelled = false
  let reading!: () => void
  const ready = new Promise<void>((resolve) => {
    reading = resolve
  })
  const stream = new ReadableStream({
    pull() {
      reading()
    },
    cancel() {
      cancelled = true
    },
  })
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => new Response(),
  })
  const sending = fetch('https://fixture.invalid', {
    method: 'POST',
    headers: bearer,
    body: stream,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit)
  await ready
  controller.abort()
  await expect(sending).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelled).toBe(true)
  expect(h.reads).toEqual([])
})

test('fresh physical sends use library TTL checks and kept 401s are never reported', async () => {
  const h = await harness([
    row('oauth', {
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'fixture-a',
    }),
  ])
  h.setGet(async (input) => {
    expect(input.minTtlMs).toBe(300_000)
    return {
      material: 'oauth-secret',
      recordVersion: 7,
      expiresAtMs: Date.now() + 600_000,
      accountId: 'account-oauth',
    }
  })
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => new Response('ok'),
  })
  await fetch('https://fixture.invalid', { headers: bearer })
  await fetch('https://fixture.invalid', { headers: bearer })
  expect(h.reads).toEqual(['oauth', 'oauth'])
  h.setOutage(true)
  const failed = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => new Response('kept-401', { status: 401 }),
  })
  expect(
    await (await failed('https://fixture.invalid', { headers: bearer })).text(),
  ).toBe('kept-401')
  expect(h.reports).toEqual([])
})

test('route_busy on a send keeps serving the key previously served for the account', async () => {
  const h = await harness([row('a')])
  const authorizations: (string | null)[] = []
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async (input) => {
      authorizations.push((input as Request).headers.get('authorization'))
      return new Response('served-ok')
    },
  })
  expect(
    await (await fetch('https://fixture.invalid', { headers: bearer })).text(),
  ).toBe('served-ok')
  h.setGet(async () => {
    throw Object.assign(new Error('no free route slot'), { code: 'route_busy' })
  })
  const kept = await fetch('https://fixture.invalid', { headers: bearer })
  expect(kept.status).toBe(200)
  expect(await kept.text()).toBe('served-ok')
  expect(h.reads).toEqual(['a', 'a'])
  expect(authorizations).toEqual(['Bearer secret-a-1', 'Bearer secret-a-1'])
})

test('owned empty and inactive providers refuse locally but remain registered', async () => {
  const h = await harness()
  expect(h.consumers.size).toBe(3)
  h.setActive(false)
  await h.hub.refresh()
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  await expect(
    fetch('https://fixture.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'no-vault-account' })
  expect(h.reads).toEqual([])
})

test('body representations are buffered once and replayed with content type intact', async () => {
  const form = new FormData()
  form.set('key', 'payload')
  for (const body of [
    'payload',
    new TextEncoder().encode('payload').buffer,
    new Blob(['payload']),
    new URLSearchParams({ key: 'payload' }),
    form,
  ]) {
    const h = await harness([row('a'), row('b')])
    const bodies: string[] = []
    const types: (string | null)[] = []
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      fetch: async (input) => {
        const request = input as Request
        bodies.push(await request.text())
        types.push(request.headers.get('content-type'))
        return new Response('result', {
          status: bodies.length === 1 ? 429 : 200,
        })
      },
    })
    const request = new Request('https://fixture.invalid', {
      method: 'POST',
      body,
      headers: bearer,
    })
    await fetch(request)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('payload')
    expect(bodies[1]).toBe(bodies[0])
    expect(types[1]).toBe(types[0])
  }
})

test('402 moves to account B and keeps its mark until Retry-After or the balance probe interval expires', async () => {
  for (const [retryAfter, expiry] of [
    [undefined, 301000],
    ['invalid', 301000],
    ['7200', 7201000],
    ['17', 18000],
    ['Thu, 01 Jan 1970 00:00:11 GMT', 11000],
    ['0', 1000],
  ] as const) {
    const h = await harness([row('a'), row('b')])
    const marks = new Map<string, number>()
    let time = 1000
    let sends = 0
    const fetch = createFetch({
      entry: balanceEntry,
      placeholder,
      consumer: h.consumer,
      now: () => time,
      rateLimitMarks: marks,
      fetch: async () => {
        sends++
        return new Response(sends === 1 ? 'insufficient balance' : 'served B', {
          status: sends === 1 ? 402 : 200,
          headers: retryAfter ? { 'retry-after': retryAfter } : {},
        })
      },
    })
    const response = await fetch('https://fixture.invalid', { headers: bearer })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served B')
    expect(h.reads).toEqual(['a', 'b'])
    expect(h.reports).toEqual([])
    expect([...marks.values()]).toEqual([expiry])
    if (expiry > time) {
      await fetch('https://fixture.invalid', { headers: bearer })
      expect(h.reads.at(-1)).toBe('b')
    }
    time = expiry + 1
    await fetch('https://fixture.invalid', { headers: bearer })
    expect(h.reads.at(-1)).toBe('a')
  }
})

for (const [service, body, moves] of [
  ['deepseek', 'Insufficient Balance', true],
  [
    'openrouter',
    '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}',
    true,
  ],
  [
    'openrouter',
    '{ "error": { "metadata": { "limit_source": "openrouter_key_limit" } } }',
    false,
  ],
  [
    'openrouter',
    '{"error":{"metadata":{"limit_source":"openrouter_in_flight_budget"}}}',
    false,
  ],
  [
    'openrouter',
    '{"error":{"metadata":{"limit_source":"openrouter_credits","reason":"weight_exceeds_budget"}}}',
    false,
  ],
  ['openrouter', '{"error":{"message":"Insufficient credits"}}', false],
  ['openrouter', 'not JSON', false],
  [
    'xai',
    '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}',
    false,
  ],
] as const) {
  test(`402 classification ${service} ${body} moves=${moves}`, async () => {
    const h = await harness([row('a'), row('b')])
    const marks = new Map<string, number>()
    let sends = 0
    const fetch = createFetch({
      entry: { ...fixtureEntries[0], service },
      placeholder,
      consumer: h.consumer,
      rateLimitMarks: marks,
      fetch: async () => {
        sends++
        return sends === 1
          ? new Response(body, { status: 402 })
          : new Response('served B')
      },
    })
    const response = await fetch('https://fixture.invalid', { headers: bearer })
    expect(response.status).toBe(moves ? 200 : 402)
    expect(await response.text()).toBe(moves ? 'served B' : body)
    expect(h.reads).toEqual(moves ? ['a', 'b'] : ['a'])
    expect(marks.size).toBe(moves ? 1 : 0)
    expect(h.reports).toEqual([])
  })
}

for (const status of [200, 402]) {
  test(`balance probe ${status === 200 ? 'success clears' : 'failure renews'} the mark without a restart`, async () => {
    const h = await harness([row('a'), row('b')])
    const marks = new Map<string, number>()
    const route = h.consumer.routingRows()[0].id
    let time = 1000
    let sends = 0
    const fetch = createFetch({
      entry: balanceEntry,
      placeholder,
      consumer: h.consumer,
      rateLimitMarks: marks,
      now: () => time,
      fetch: async () => {
        sends++
        return new Response('balance probe', {
          status: sends === 1 ? 402 : sends === 3 ? status : 200,
        })
      },
    })
    await fetch('https://fixture.invalid', { headers: bearer })
    time = 301001
    await fetch('https://fixture.invalid', { headers: bearer })
    expect(h.reads.slice(0, 3)).toEqual(['a', 'b', 'a'])
    if (status === 200) expect(marks.has(route)).toBe(false)
    else {
      expect(marks.get(route)).toBe(601001)
      await fetch('https://fixture.invalid', { headers: bearer })
      expect(h.reads.at(-1)).toBe('b')
      time = 601002
      await fetch('https://fixture.invalid', { headers: bearer })
      expect(h.reads.at(-1)).toBe('a')
      expect(marks.has(route)).toBe(false)
    }
    expect(h.reports).toEqual([])
  })
}

test('an all-marked balance account recovers on a fresh request after expiry', async () => {
  const h = await harness()
  const marks = new Map<string, number>()
  let time = 1000
  let sends = 0
  const fetch = createFetch({
    entry: balanceEntry,
    placeholder,
    consumer: h.consumer,
    rateLimitMarks: marks,
    now: () => time,
    fetch: async () =>
      new Response('probe', { status: ++sends === 1 ? 402 : 200 }),
  })
  expect(
    (await fetch('https://fixture.invalid', { headers: bearer })).status,
  ).toBe(402)
  time = 2000
  const limited = await fetch('https://fixture.invalid', { headers: bearer })
  expect(limited.status).toBe(402)
  expect(await limited.json()).toEqual({
    error: 'claustrum-auth: insufficient balance',
  })
  expect(limited.headers.get('retry-after')).toBe('299')
  expect(sends).toBe(1)
  time = 301001
  expect(
    (await fetch('https://fixture.invalid', { headers: bearer })).status,
  ).toBe(200)
  expect(sends).toBe(2)
  expect(marks.size).toBe(0)
})

test('a balance probe that hits a key cap returns its body without a mark', async () => {
  const h = await harness([row('a'), row('b')])
  const marks = new Map<string, number>()
  let time = 1000
  let sends = 0
  const body = '{"error":{"metadata":{"limit_source":"openrouter_key_limit"}}}'
  const fetch = createFetch({
    entry: { ...fixtureEntries[0], service: 'openrouter' },
    placeholder,
    consumer: h.consumer,
    rateLimitMarks: marks,
    now: () => time,
    fetch: async () => {
      sends++
      if (sends === 2) return new Response('served B')
      return new Response(
        sends === 1
          ? '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}'
          : body,
        { status: 402 },
      )
    },
  })
  await fetch('https://fixture.invalid', { headers: bearer })
  time = 301001
  const response = await fetch('https://fixture.invalid', { headers: bearer })
  expect(response.status).toBe(402)
  expect(await response.text()).toBe(body)
  expect(h.reads).toEqual(['a', 'b', 'a'])
  expect(marks.size).toBe(0)
})

test('an unconfirmed 402 body and headers still redact the served credential', async () => {
  const h = await harness([row('a'), row('b')])
  const marks = new Map<string, number>()
  const fetch = createFetch({
    entry: { ...fixtureEntries[0], service: 'openrouter' },
    placeholder,
    consumer: h.consumer,
    rateLimitMarks: marks,
    fetch: async () =>
      Response.json(
        {
          error: {
            message: 'secret-a-1',
            metadata: { limit_source: 'openrouter_key_limit' },
          },
        },
        { status: 402, headers: { 'x-echo': 'secret-a-1' } },
      ),
  })
  const response = await fetch('https://fixture.invalid', { headers: bearer })
  expect(response.status).toBe(402)
  const text = await response.text()
  expect(text).toContain('openrouter_key_limit')
  expect(text).not.toContain('secret-a-1')
  expect(response.headers.get('x-echo')).not.toContain('secret-a-1')
  expect(h.reads).toEqual(['a'])
  expect(marks.size).toBe(0)
  expect(h.reports).toEqual([])
})

test('429 marks persist across calls until numeric date or default expiry', async () => {
  for (const [retryAfter, expiry] of [
    [undefined, 61000],
    ['invalid', 61000],
    ['17', 18000],
    ['Thu, 01 Jan 1970 00:00:11 GMT', 11000],
  ] as const) {
    const h = await harness([row('a'), row('b')])
    const marks = new Map<string, number>()
    let time = 1000
    const auth: string[] = []
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      now: () => time,
      rateLimitMarks: marks,
      fetch: async (input) => {
        auth.push((input as Request).headers.get('authorization') ?? '')
        return new Response('result', {
          status: auth.length === 1 ? 429 : 200,
          headers: retryAfter ? { 'retry-after': retryAfter } : {},
        })
      },
    })
    await fetch('https://fixture.invalid', { headers: bearer })
    expect([...marks.values()]).toEqual([expiry])
    await fetch('https://fixture.invalid', { headers: bearer })
    expect(auth).toEqual([
      'Bearer secret-a-1',
      'Bearer secret-b-1',
      'Bearer secret-b-1',
    ])
    time = expiry + 1
    await fetch('https://fixture.invalid', { headers: bearer })
    expect(auth.at(-1)).toBe('Bearer secret-a-1')
  }
})

test('each account is tried at most once even with a zero retry-after', async () => {
  const h = await harness([row('a'), row('b')])
  const auth: string[] = []
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    now: () => 1000,
    fetch: async (input) => {
      auth.push((input as Request).headers.get('authorization') ?? '')
      return new Response('last', {
        status: auth.length <= 2 ? 429 : 200,
        headers: { 'retry-after': '0' },
      })
    },
  })
  const response = await fetch('https://fixture.invalid', { headers: bearer })
  expect(response.status).toBe(429)
  expect(await response.text()).toBe('last')
  expect(auth).toEqual(['Bearer secret-a-1', 'Bearer secret-b-1'])
})

test('the body is buffered without deriving a request that takes it over', async () => {
  const Native = globalThis.Request
  // Under the Fetch standard, as Node's undici implements it,
  // `new Request(request, { body: null })` moves the body of `request` into
  // the new request instead of dropping it, which locks the original. Bun
  // drops it instead, so this models the standard for the test.
  class StandardRequest extends Native {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init)
      if (
        input instanceof Native &&
        input.body &&
        init &&
        'body' in init &&
        init.body == null
      )
        input.body.getReader()
    }
  }
  globalThis.Request = StandardRequest as typeof Request
  try {
    const h = await harness()
    const bodies: string[] = []
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      fetch: async (input) => {
        bodies.push(await (input as Request).text())
        return new Response('ok')
      },
    })
    const response = await fetch('https://fixture.invalid/v1', {
      method: 'POST',
      headers: bearer,
      body: '{"prompt":"hi"}',
    })
    expect(await response.text()).toBe('ok')
    expect(bodies).toEqual(['{"prompt":"hi"}'])
  } finally {
    globalThis.Request = Native
  }
})
