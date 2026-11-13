import { expect, test } from 'bun:test'
import { BillingAttempt, observeBillingResponse } from '../src/billing.ts'
import { routedCompletion } from '../src/routing.ts'
import { createFetch, fixtureEntries } from '../test-entry.ts'
import { bearer, harness, placeholder, row } from './fakes.ts'
import { installRoutingAccessor } from './routing-accessor-fixture.ts'
import { routing } from './routing-fixtures.ts'

for (const host of ['opencode1', 'pi'] as const) {
  test(`routing ${host}: completed routed replies report served once with only rate-limit headers`, async () => {
    const h = await harness([row('key', { accountId: undefined })], host)
    const { reports } = routing(async () => ({ account_id: 'key' }))
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
      billing:
        host === 'pi'
          ? (receipt) =>
              new BillingAttempt(
                fixtureEntries[0],
                'fixture-a',
                'session',
                'primary',
                'model',
                receipt,
              )
          : undefined,
      fetch: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
            'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
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
        ),
    })
    const response = await serve('https://fixture.invalid', { headers: bearer })
    expect(reports).toEqual([])
    await response.text()
    expect(
      reports.filter(
        (report) => (report as { outcome: string }).outcome === 'served',
      ),
    ).toEqual([
      {
        account_id: 'key',
        credential_id: 'key',
        outcome: 'served',
        headers: {
          'x-ratelimit-remaining': '001',
          'ratelimit-reset': '42',
          'anthropic-ratelimit-tokens-limit': '1000',
          'retry-after': '3',
        },
      },
    ])
    expect(reports).toHaveLength(host === 'pi' ? 2 : 1)
  })

  test(`routing ${host}: JSON EOF reports served with empty headers without billing`, async () => {
    const h = await harness([row('key', { accountId: undefined })], host)
    const { reports } = routing(async () => ({ account_id: 'key' }))
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
      fetch: async () =>
        new Response('{"choices":[{"message":{"content":"ok"}}]}'),
    })
    await (await serve('https://fixture.invalid', { headers: bearer })).text()
    expect(reports).toEqual([
      {
        account_id: 'key',
        credential_id: 'key',
        outcome: 'served',
        headers: {},
      },
    ])
  })

  test(`routing ${host}: a cut or failed SSE reply never reports served`, async () => {
    for (const ending of [
      'cancel',
      'eof',
      'error',
      'protocol-error',
    ] as const) {
      const h = await harness([row('key', { accountId: undefined })], host)
      const { reports } = routing(async () => ({ account_id: 'key' }))
      let source!: ReadableStreamDefaultController<Uint8Array>
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
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                source = controller
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                  ),
                )
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      })
      const response = await serve('https://fixture.invalid', {
        headers: bearer,
      })
      if (!response.body) throw new Error('missing response body')
      const reader = response.body.getReader()
      expect((await reader.read()).done).toBe(false)
      if (ending === 'cancel') await reader.cancel()
      else if (ending === 'error') {
        source.error(new Error('cut reply'))
        await expect(reader.read()).rejects.toThrow('cut reply')
      } else {
        if (ending === 'protocol-error')
          source.enqueue(
            new TextEncoder().encode(
              'data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n',
            ),
          )
        source.close()
        while (!(await reader.read()).done) {}
      }
      expect(reports).toEqual([])
    }
  })

  test(`routing ${host}: cancellation after a terminal marker reports served once`, async () => {
    for (const terminal of [
      '[DONE]',
      '{"choices":[{"finish_reason":"stop"}]}',
      '{"type":"response.completed","response":{"id":"reply"}}',
    ]) {
      const h = await harness([row('key', { accountId: undefined })], host)
      const { reports } = routing(async () => ({ account_id: 'key' }))
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
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${terminal}\n\n`),
                )
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      })
      const response = await serve('https://fixture.invalid', {
        headers: bearer,
      })
      if (!response.body) throw new Error('missing response body')
      const reader = response.body.getReader()
      await reader.read()
      expect(reports).toEqual([])
      await reader.cancel()
      expect(reports).toEqual([
        {
          account_id: 'key',
          credential_id: 'key',
          outcome: 'served',
          headers: {},
        },
      ])
    }
  })

  test(`routing ${host}: non-2xx replies never report served and balance refusals are unchanged`, async () => {
    for (const status of [400, 401, 402, 403, 429, 500]) {
      const h = await harness([row('key', { accountId: undefined })], host)
      const { reports } = routing(async () => ({ account_id: 'key' }))
      const serve = createFetch({
        entry: { ...fixtureEntries[0], service: 'deepseek' },
        placeholder,
        consumer: h.consumer,
        host,
        routing: {
          sessionId: 'session',
          provider: 'deepseek',
          modelId: 'model',
        },
        fetch: async () => new Response('{}', { status }),
      })
      await serve('https://fixture.invalid', { headers: bearer })
        .then((response) => response.text())
        .catch(() => {})
      expect(reports).toEqual(
        status === 402
          ? [
              {
                account_id: 'key',
                credential_id: 'key',
                outcome: 'credential_refused',
                provider_code: 'http_402',
              },
            ]
          : [],
      )
    }
  })

  test(`routing ${host}: absent accessor and subscription rows add no completion observation`, async () => {
    for (const subscription of [false, true]) {
      const h = await harness(
        [
          row(
            'key',
            subscription
              ? {
                  credentialType: 'oauth',
                  authMethod: 'oauth',
                  refreshAdapter: 'fixture-a',
                }
              : {},
          ),
        ],
        host,
      )
      const { calls, reports } = routing(async () => {
        throw new Error('must not ask routing')
      })
      if (!subscription) installRoutingAccessor()
      const original = new Response('{"ok":true}')
      expect(
        observeBillingResponse(
          undefined,
          original,
          routedCompletion(undefined, 'session', original),
        ),
      ).toBe(original)
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
        fetch: async () => original,
      })
      const response = await serve('https://fixture.invalid', {
        headers: bearer,
      })
      expect(response.bodyUsed).toBe(false)
      await response.text()
      expect(calls).toEqual([])
      expect(reports).toEqual([])
    }
  })

  test(`routing ${host}: a throwing or pending report accessor cannot hold up the reply`, async () => {
    for (const throws of [false, true]) {
      const h = await harness([row('key', { accountId: undefined })], host)
      routing(async () => ({ account_id: 'key' }))
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
        fetch: async () => new Response('{"ok":true}'),
      })
      const response = await serve('https://fixture.invalid', {
        headers: bearer,
      })
      let reported = 0
      installRoutingAccessor(() => ({
        report() {
          reported++
          if (throws) throw new Error('accessor unavailable')
          return new Promise(() => {})
        },
      }))
      expect(await response.text()).toBe('{"ok":true}')
      expect(reported).toBe(1)
    }
  })
}
