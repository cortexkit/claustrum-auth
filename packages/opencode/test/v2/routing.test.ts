import { expect, test } from 'bun:test'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { harness, row } from '../../../core/test/fakes.ts'
import { routing } from '../../../core/test/routing-fixtures.ts'
import { fixtureEntries } from '../../../core/test-entry.ts'
import { createVaultAdapter } from '../../src/v2/adapter.ts'

const scope = {
  sessionID: 'session',
  providerID: 'fixture-a',
  modelID: 'model',
  kind: 'primary' as const,
  agent: 'build',
}

test('routing OC2 OAuth-only and mixed pools preserve subscription choice until an API-key attempt', async () => {
  for (const mixed of [false, true]) {
    const h = await harness(
      [
        row('oauth', {
          credentialType: 'oauth',
          authMethod: 'oauth',
          refreshAdapter: 'fixture-a',
        }),
        ...(mixed ? [row('key')] : []),
      ],
      'opencode2',
    )
    const adapter = createVaultAdapter({
      entry: fixtureEntries[0],
      provider: 'fixture-a',
      consumer: async () => h.consumer,
      rateLimitMarks: new Map(),
    })
    if (mixed)
      await h.consumer.reorder(
        ['oauth', 'key'].map(
          (id) =>
            h.consumer.snapshot()?.rows.find((row) => row.credentialId === id)
              ?.routeId as string,
        ),
      )
    const { calls } = routing(async () => ({ account_id: 'account-key' }))
    const first = await adapter.chooseAccount({ ...scope, phase: 'request' })
    expect(first).toBe(
      h.consumer.snapshot()?.rows.find((row) => row.credentialId === 'oauth')
        ?.routeId,
    )
    expect(calls).toEqual([])
    if (mixed && typeof first === 'string') {
      const next = await adapter.chooseAccount({
        ...scope,
        phase: 'retry',
        rerouteFrom: {
          accountId: first,
          limit: { status: 429, reason: 'rate-limit' },
        },
        excluded: [first],
      })
      expect(next).toBe(
        h.consumer.snapshot()?.rows.find((row) => row.credentialId === 'key')
          ?.routeId,
      )
      expect(calls).toHaveLength(1)
    }
  }
})
async function world(service = 'fixture-a', subscription = false) {
  const h = await harness(
    subscription
      ? [
          row('oauth', {
            credentialType: 'oauth',
            authMethod: 'oauth',
            refreshAdapter: 'fixture-a',
          }),
        ]
      : [
          row('a', { accountId: undefined }),
          row('b', { accountId: undefined }),
        ],
    'opencode2',
  )
  const adapter = createVaultAdapter({
    entry: { ...fixtureEntries[0], service },
    provider: 'fixture-a',
    consumer: async () => h.consumer,
    rateLimitMarks: new Map(),
  })
  const send = async (input = { ...scope, phase: 'request' as const }) => {
    const choice = await adapter.chooseAccount(input)
    if (typeof choice !== 'string') throw new Error('expected account')
    const headers = await adapter.accountHeaders({
      ...scope,
      accountId: choice,
    })
    if (!headers.attempt || typeof headers.attempt !== 'object')
      throw new Error('missing attempt')
    const attempt = {
      ...scope,
      attemptId: 'attempt',
      accountId: choice,
      data: headers.attempt,
      transport: 'http' as const,
    }
    const request = new Request('https://fixture.invalid', {
      headers: { authorization: `Bearer ${placeholderSecret('fixture-a')}` },
    })
    const sent = await adapter.rewriteRequest?.({
      ...scope,
      request,
      accountId: choice,
      attempt,
    })
    const respond = async (response: Response) => {
      const rewritten = await adapter.rewriteResponse?.({
        ...scope,
        accountId: choice,
        request: sent ?? request,
        response,
        attempt,
      })
      if (!rewritten) throw new Error('missing rewritten response')
      return rewritten
    }
    return { sent, attempt, respond }
  }
  return { h, adapter, send }
}

test('routing OC2 selection serves routing key for primary titles and compaction; absent accessor preserves roster', async () => {
  const { send, adapter, h } = await world()
  const first = await send()
  expect(first.sent?.headers.get('authorization')).toBe('Bearer secret-a-1')
  const { calls } = routing(async () => ({ account_id: 'b' }))
  for (const kind of ['primary', 'title', 'compaction'] as const)
    expect(
      await adapter.chooseAccount({ ...scope, kind, phase: 'request' }),
    ).toBe(
      h.consumer.snapshot()?.rows.find((r) => r.credentialId === 'b')?.routeId,
    )
  expect((await send()).sent?.headers.get('authorization')).toBe(
    'Bearer secret-b-1',
  )
  expect(calls).toHaveLength(4)
})

test('routing OC2 refusal and no answer authorize and send nothing', async () => {
  const { send, h } = await world()
  for (const [answer, text] of [
    [
      { refused: { code: 'account_selection_final' } },
      'Thalamus routing declined this request, so it was not sent.',
    ],
    [
      undefined,
      'Thalamus routing did not answer, so this API key request was not sent.',
    ],
  ] as const) {
    routing(async () => answer)
    await expect(send()).rejects.toThrow(text)
  }
  expect(h.reads).toEqual([])
})

test('routing OC2 retry excludes earlier keys and asks again', async () => {
  const { adapter, h } = await world()
  const a = h.consumer.snapshot()?.rows.find((r) => r.credentialId === 'a')
    ?.routeId as string
  const b = h.consumer.snapshot()?.rows.find((r) => r.credentialId === 'b')
    ?.routeId as string
  const { calls } = routing(async (call) => ({
    account_id: call === 2 ? 'a' : 'b',
  }))
  const retry = {
    ...scope,
    phase: 'retry' as const,
    excluded: [a],
    rerouteFrom: { accountId: a, limit: { status: 429, reason: 'rate-limit' } },
  }
  expect(await adapter.chooseAccount(retry)).toBe(b)
  await expect(
    adapter.chooseAccount({ ...retry, excluded: [a, b] }),
  ).rejects.toThrow('did not answer')
  expect(calls).toHaveLength(2)
})

test('routing OC2 balance reports once and never for auth rate limits or self-set caps', async () => {
  for (const [service, status, body, code] of [
    ['deepseek', 402, '{}', 'http_402'],
    ['deepseek', 402, '{"error":{"code":"request_failed"}}', 'http_402'],
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
    ['deepseek', 401, '{}', undefined],
    ['deepseek', 429, '{}', undefined],
  ] as const) {
    const { send, adapter } = await world(service)
    const { reports } = routing(async () => ({ account_id: 'b' }))
    const { attempt } = await send()
    for (let i = 0; i < 2; i++)
      await adapter.limitFromResponse?.({
        status,
        headers: new Headers(),
        body: async () => body,
        attempt,
      })
    expect(reports).toEqual(
      code
        ? [
            {
              account_id: 'b',
              credential_id: 'b',
              outcome: 'credential_refused',
              provider_code: code,
            },
          ]
        : [],
    )
  }
})

test('routing OC2 completed routed replies report served once with only rate-limit headers', async () => {
  const { send } = await world()
  const { reports } = routing(async () => ({ account_id: 'b' }))
  const { respond } = await send()
  const original = new Response(
    'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    {
      headers: {
        'content-type': 'text/event-stream',
        'X-RateLimit-Remaining': '001',
        'RateLimit-Reset': '42',
        'Anthropic-RateLimit-Tokens-Limit': '1000',
        'Retry-After': '3',
        authorization: 'must-not-report',
        'set-cookie': 'must-not-report',
        'x-request-id': 'must-not-report',
      },
    },
  )
  const response = await respond(original)
  expect(reports).toEqual([])
  await response.text()
  expect(
    reports.filter(
      (report) => (report as { outcome: string }).outcome === 'served',
    ),
  ).toEqual([
    {
      account_id: 'b',
      credential_id: 'b',
      outcome: 'served',
      headers: {
        'x-ratelimit-remaining': '001',
        'ratelimit-reset': '42',
        'anthropic-ratelimit-tokens-limit': '1000',
        'retry-after': '3',
      },
    },
  ])
  expect(
    reports.filter(
      (report) => (report as { kind?: string }).kind === 'billing',
    ),
  ).toHaveLength(1)
})

test('routing OC2 JSON EOF reports served with empty headers', async () => {
  const { send } = await world()
  const { reports } = routing(async () => ({ account_id: 'b' }))
  const { respond } = await send()
  const response = await respond(new Response('{"ok":true}'))
  await response.text()
  expect(
    reports.filter(
      (report) => (report as { outcome: string }).outcome === 'served',
    ),
  ).toEqual([
    { account_id: 'b', credential_id: 'b', outcome: 'served', headers: {} },
  ])
})

test('routing OC2 cuts send no served; terminal cancellation sends exactly one', async () => {
  for (const terminal of [false, true]) {
    const { send } = await world()
    const { reports } = routing(async () => ({ account_id: 'b' }))
    const { respond } = await send()
    const original = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              terminal
                ? 'data: [DONE]\n\n'
                : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            ),
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const response = await respond(original)
    if (!response.body) throw new Error('missing response body')
    const reader = response.body.getReader()
    await reader.read()
    expect(reports).toEqual([])
    await reader.cancel()
    expect(
      reports.filter(
        (report) => (report as { outcome: string }).outcome === 'served',
      ),
    ).toEqual(
      terminal
        ? [
            {
              account_id: 'b',
              credential_id: 'b',
              outcome: 'served',
              headers: {},
            },
          ]
        : [],
    )
  }
})

test('routing OC2 non-2xx replies never report served', async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    const { send, adapter } = await world('deepseek')
    const { reports } = routing(async () => ({ account_id: 'b' }))
    const { attempt, respond } = await send()
    await adapter.limitFromResponse?.({
      status,
      headers: new Headers(),
      body: async () => '{}',
      attempt,
    })
    const response = await respond(new Response('{}', { status }))
    await response.text()
    expect(
      reports.filter(
        (report) => (report as { kind?: string }).kind !== 'billing',
      ),
    ).toEqual(
      status === 402
        ? [
            {
              account_id: 'b',
              credential_id: 'b',
              outcome: 'credential_refused',
              provider_code: 'http_402',
            },
          ]
        : [],
    )
  }
})

test('routing OC2 absent accessor and subscription rows add no completion observation', async () => {
  for (const subscription of [false, true]) {
    const { send } = await world('fixture-a', subscription)
    const { reports, calls } = subscription
      ? routing(async () => {
          throw new Error('must not ask routing')
        })
      : { reports: [], calls: [] }
    const { respond } = await send()
    const original = new Response('{"ok":true}')
    const response = await respond(original)
    if (!subscription) {
      expect(response.bodyUsed).toBe(false)
    }
    await response.text()
    expect(calls).toEqual([])
    expect(
      reports.filter(
        (report) => (report as { outcome: string }).outcome === 'served',
      ),
    ).toEqual([])
  }
})
