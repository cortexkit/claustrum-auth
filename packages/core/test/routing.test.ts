import { expect, test } from 'bun:test'
import { createFetch, fixtureEntries } from '../test-entry.ts'
import { bearer, harness, placeholder, row } from './fakes.ts'
import { routing } from './routing-fixtures.ts'

const symbol = Symbol.for('cortexkit.routing')

for (const host of ['opencode1', 'pi'] as const) {
  test(`routing ${host}: OAuth-only subscriptions serve without asking routing`, async () => {
    const h = await harness(
      [
        row('oauth', {
          credentialType: 'oauth',
          authMethod: 'oauth',
          refreshAdapter: 'fixture-a',
        }),
      ],
      host,
    )
    const { calls } = routing(async () => {
      throw new Error('OAuth must not ask')
    })
    const serve = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      host,
      fetch: async () => new Response('subscription'),
    })
    expect(
      await (
        await serve('https://fixture.invalid', { headers: bearer })
      ).text(),
    ).toBe('subscription')
    expect(h.reads).toEqual(['oauth'])
    expect(calls).toEqual([])
  })

  test(`routing ${host}: mixed pools ask only when the usual next row is an API key`, async () => {
    const h = await harness(
      [
        row('oauth', {
          credentialType: 'oauth',
          authMethod: 'oauth',
          refreshAdapter: 'fixture-a',
        }),
        row('apikey'),
      ],
      host,
    )
    const sent: string[] = []
    const { calls } = routing(async () => ({ account_id: 'account-apikey' }))
    const order = ['oauth', 'apikey'].map(
      (id) =>
        h.consumer.snapshot()?.rows.find((row) => row.credentialId === id)
          ?.routeId as string,
    )
    await h.consumer.reorder(order)
    const serve = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      host,
      routing: {
        sessionId: 'session',
        provider: 'fixture-a',
        modelId: 'model',
      },
      fetch: async (input) => {
        sent.push(new Request(input).headers.get('authorization') ?? '')
        return sent.length === 1
          ? new Response('limited', { status: 429 })
          : new Response('paid')
      },
    })
    expect(
      await (
        await serve('https://fixture.invalid', { headers: bearer })
      ).text(),
    ).toBe('paid')
    expect(sent).toEqual(['Bearer secret-oauth-1', 'Bearer secret-apikey-1'])
    expect(calls).toHaveLength(1)
  })
}

test('routing no-answer stop never sends the plugin first key', async () => {
  const h = await harness()
  routing(async () => undefined)
  let sends = 0
  const serve = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    routing: { sessionId: 'session', provider: 'fixture-a', modelId: 'model' },
    fetch: async () => {
      sends++
      return new Response('not admitted')
    },
  })
  await expect(
    serve('https://fixture.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'routing-no-answer' })
  expect(sends).toBe(0)
  expect(h.reads).toEqual([])
})

test('routing candidates exclude user-disabled rows OAuth and other providers', async () => {
  const h = await harness([
    row('a'),
    row('b'),
    row('oauth', {
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'fixture-a',
    }),
    row('other', { providerIds: ['fixture-b'] }),
  ])
  const a = h.consumer.snapshot()?.rows.find((row) => row.credentialId === 'a')
  if (!a) throw new Error('missing row')
  await h.consumer.decline(a.routeId)
  let sends = 0
  const serve = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    routing: { sessionId: 'session', provider: 'fixture-a', modelId: 'model' },
    fetch: async () => {
      sends++
      return new Response('ok')
    },
  })
  for (const id of ['a', 'oauth', 'other']) {
    routing(async () => ({ account_id: `account-${id}` }))
    await expect(
      serve('https://fixture.invalid', { headers: bearer }),
    ).rejects.toMatchObject({ code: 'routing-no-answer' })
  }
  expect(sends).toBe(0)
})

test('routing rechecks each redirect and never rotates a 401 behind routing', async () => {
  const h = await harness()
  let sends = 0
  const { calls } = routing(async (call) =>
    call === 1
      ? { account_id: 'account-a' }
      : { refused: { code: 'account_selection_final' } },
  )
  const serve = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    routing: { sessionId: 'session', provider: 'fixture-a', modelId: 'model' },
    fetch: async () => {
      sends++
      return new Response(null, { status: 307, headers: { location: '/next' } })
    },
  })
  await expect(
    serve('https://fixture.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'routing-declined' })
  expect(calls).toHaveLength(2)
  expect(sends).toBe(1)
  routing(async () => ({ account_id: 'account-a' }))
  const authFailure = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    routing: { sessionId: 'session', provider: 'fixture-a', modelId: 'model' },
    fetch: async () => {
      sends++
      return new Response('bad key', { status: 401 })
    },
  })
  expect(
    (await authFailure('https://fixture.invalid', { headers: bearer })).status,
  ).toBe(401)
  expect(sends).toBe(2)
})

for (const host of ['opencode1', 'pi'] as const) {
  test(`routing ${host}: selection overrides roster and local marks; no accessor keeps today's choice`, async () => {
    const h = await harness(
      [row('a', { accountId: undefined }), row('b', { accountId: undefined })],
      host,
    )
    const sent: string[] = []
    const marks = new Map<string, number>()
    const serve = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      host,
      routing: {
        sessionId: 'session',
        provider: 'fixture-a',
        modelId: 'model',
      },
      rateLimitMarks: marks,
      fetch: async (input) => {
        sent.push(new Request(input).headers.get('authorization') ?? '')
        return new Response('ok')
      },
    })
    Reflect.deleteProperty(globalThis, symbol)
    await serve('https://fixture.invalid', { headers: bearer })
    expect(sent).toEqual(['Bearer secret-a-1'])
    for (const r of h.consumer.routingRows())
      marks.set(r.id, Date.now() + 60000)
    const { calls } = routing(async () => ({
      account_id: 'b',
      credential_id: 'b',
    }))
    await serve('https://fixture.invalid', { headers: bearer })
    expect(sent).toEqual(['Bearer secret-a-1', 'Bearer secret-b-1'])
    expect(calls).toEqual([
      {
        session: 'session',
        request: { provider: 'fixture-a', modelId: 'model', refusals: true },
        options: { deadlineMs: 1500 },
      },
    ])
  })

  test(`routing ${host}: refusal and no answer send nothing`, async () => {
    const h = await harness(undefined, host)
    let sends = 0
    const serve = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      host,
      routing: {
        sessionId: 'session',
        provider: 'fixture-a',
        modelId: 'model',
      },
      fetch: async () => {
        sends++
        return new Response('ok')
      },
    })
    for (const [answer, code] of [
      [
        {
          refused: {
            code: 'account_selection_refused',
            routing_code: 'private-label',
          },
        },
        'routing-declined',
      ],
      [undefined, 'routing-no-answer'],
    ] as const) {
      routing(async () => answer)
      await expect(
        serve('https://fixture.invalid', { headers: bearer }),
      ).rejects.toMatchObject({ code })
    }
    expect(sends).toBe(0)
    expect(h.reads).toEqual([])
  })

  test(`routing ${host}: retries ask again and exclude every tried key`, async () => {
    const h = await harness([row('a'), row('b'), row('c')], host)
    const serve = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      host,
      routing: {
        sessionId: 'session',
        provider: 'fixture-a',
        modelId: 'model',
      },
      fetch: async () => new Response('limited', { status: 429 }),
    })
    const { calls } = routing(async (call) => ({
      account_id: call === 2 ? 'account-b' : 'account-a',
    }))
    await expect(
      serve('https://fixture.invalid', { headers: bearer }),
    ).rejects.toMatchObject({ code: 'routing-no-answer' })
    expect(calls).toHaveLength(3)
    expect(h.reads).toEqual(['a', 'b'])
  })
}

test('routing reports only qualifying balance refusals with vault identities and provider codes', async () => {
  for (const [service, status, body, code] of [
    ['deepseek', 402, '{}', 'http_402'],
    ['deepseek', 402, '{"error":{"code":"balance_empty"}}', 'balance_empty'],
    [
      'openrouter',
      402,
      '{"error":{"metadata":{"limit_source":"openrouter_credits"}}}',
      'openrouter_credits',
    ],
    [
      'openrouter',
      402,
      '{"error":{"metadata":{"limit_source":"key_limit"}}}',
      undefined,
    ],
    [
      'openrouter',
      402,
      '{"error":{"metadata":{"limit_source":"openrouter_credits","reason":"weight_exceeds_budget"}}}',
      undefined,
    ],
    ['deepseek', 401, '{}', undefined],
    ['deepseek', 403, '{}', undefined],
    ['deepseek', 429, '{}', undefined],
  ] as const) {
    const h = await harness([row('a', { accountId: undefined }), row('b')])
    const { reports } = routing(async (call) =>
      call === 1
        ? { account_id: 'a' }
        : { refused: { code: 'account_selection_final' } },
    )
    const serve = createFetch({
      entry: { ...fixtureEntries[0], service },
      placeholder,
      consumer: h.consumer,
      routing: { sessionId: 'session', provider: service, modelId: 'model' },
      fetch: async () => new Response(body, { status }),
    })
    await serve('https://fixture.invalid', { headers: bearer }).catch(() => {})
    expect(reports).toEqual(
      code
        ? [
            {
              account_id: 'a',
              credential_id: 'a',
              outcome: 'credential_refused',
              provider_code: code,
            },
          ]
        : [],
    )
  }
})
