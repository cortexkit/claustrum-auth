import { expect, test } from 'bun:test'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import {
  type ProviderEntry,
  supportedProviders,
} from '../../../core/src/providers.ts'
import {
  captureBilling,
  chatChunks,
  chatResponse,
  expectedUsage,
} from '../../../core/test/billing-fixtures.ts'
import { vaultRowFor } from '../../../core/test/fakes.ts'
import { installRoutingAccessor } from '../../../core/test/routing-accessor-fixture.ts'
import { vaultMethodId } from '../../src/v2/setup.ts'
import { scope, startServer, trigger } from './fakes.ts'

async function setup(provider: string, tableEntry?: ProviderEntry) {
  const entry =
    tableEntry ?? supportedProviders.find((row) => row.service === provider)
  if (!entry) throw new Error('missing provider')
  const { host } = await startServer({
    rows: [vaultRowFor(entry, { accountId: 'account-1' })],
    catalog: [{ id: provider }],
    table: [entry],
  })
  const method = host.methods.get(`${provider}:${vaultMethodId}`)
  if (!method) throw new Error('missing method')
  await (await method.authorize({})).callback
  const scoped = {
    ...scope(provider),
    model: { providerID: provider, id: 'sent-model' },
  }
  const request = (key = placeholderSecret(provider)) =>
    new Request(`${entry.origins[0]}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: '{}',
    })
  let sent = request()
  const send = async (key?: string) => {
    sent = (
      await trigger(host, 'http.request', { ...scoped, request: request(key) })
    ).request
  }
  const response = async (reply: Response) =>
    (
      await trigger(host, 'http.response', {
        ...scoped,
        request: sent,
        response: reply,
      })
    ).response
  return { host, scoped, send, response }
}

for (const provider of ['deepseek', 'cerebras'] as const) {
  test(`${provider} vault HTTP billing reports the documented stream exactly once at body end`, async () => {
    const { reports, sessions } = captureBilling(true)
    const run = await setup(provider)
    await run.send()
    const response = await run.response(chatResponse(provider))
    expect(reports).toEqual([])
    await response.text()
    expect(reports).toEqual([
      {
        kind: 'billing',
        attempt_id: expect.any(String),
        request_kind: 'primary',
        credential_id: `apikey:${provider}`,
        account_id: 'account-1',
        provider,
        model: 'sent-model',
        outcome: 'completed',
        status: 200,
        provider_response_id: 'reply-1',
        ...(provider === 'deepseek' ? { charge_basis: 'metered_api' } : {}),
        usage: expectedUsage,
        cache: {
          implicit: true,
          warming: { on: false, stop_reason: 'unsupported' },
        },
      },
    ])
    expect(sessions.every((session) => session === run.scoped.sessionID)).toBe(
      true,
    )
  })
}

test('a reply model alias keeps one report at the sent model without usageByModel', async () => {
  const { reports } = captureBilling()
  const run = await setup('deepseek')
  await run.send()
  const response = new Response(
    `${chatChunks('deepseek')
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ ...chunk, model: 'deepseek/deepseek-chat-2026-01-01' })}\n\n`,
      )
      .join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
  await (await run.response(response)).text()
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    model: 'sent-model',
    usage: expectedUsage,
  })
  expect(reports[0]).not.toHaveProperty('usage_by_model')
  expect(reports[0]).not.toHaveProperty('usageByModel')
})

test('without an accessor a served host request never looks up billing semantics', async () => {
  installRoutingAccessor()
  const base = supportedProviders.find((entry) => entry.service === 'deepseek')
  if (!base?.billing) throw new Error('missing deepseek')
  let parsed = 0
  const run = await setup('deepseek', {
    ...base,
    billing: new Proxy(base.billing, {
      get(target, key, receiver) {
        parsed++
        return Reflect.get(target, key, receiver)
      },
    }),
  })
  parsed = 0
  await run.send()
  await (await run.response(chatResponse('deepseek'))).text()
  expect(parsed).toBe(0)
})

test('a user-key host request sends no billing report and never parses usage', async () => {
  const { reports } = captureBilling()
  const base = supportedProviders.find((entry) => entry.service === 'deepseek')
  if (!base?.billing) throw new Error('missing deepseek')
  let parsed = 0
  const run = await setup('deepseek', {
    ...base,
    billing: new Proxy(base.billing, {
      get(target, key, receiver) {
        parsed++
        return Reflect.get(target, key, receiver)
      },
    }),
  })
  parsed = 0
  await run.send('user-key')
  const reply = chatResponse('deepseek')
  expect(await run.response(reply)).toBe(reply)
  await reply.text()
  expect(reports).toEqual([])
  expect(parsed).toBe(0)
})

test('a cut HTTP stream reports cut without invented usage', async () => {
  const { reports } = captureBilling()
  const run = await setup('deepseek')
  await run.send()
  const first = chatChunks('deepseek')[0]
  const reply = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`),
        )
      },
    }),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
  const reader = (await run.response(reply)).body?.getReader()
  await reader?.read()
  await reader?.cancel()
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    outcome: 'cut',
    provider_response_id: 'reply-1',
  })
  expect(reports[0]).not.toHaveProperty('usage')
})

for (const withUsage of [true, false]) {
  test(`cancelling after finish_reason ${withUsage ? 'with usage' : 'before trailing usage'} reports completed`, async () => {
    const { reports } = captureBilling()
    const run = await setup('deepseek')
    await run.send()
    const chunks = chatChunks('deepseek')
    const terminal = chunks[1]
    if (!terminal) throw new Error('missing terminal fixture')
    const bytes = [
      chunks[0],
      { ...terminal, usage: withUsage ? terminal.usage : undefined },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('')
    let cancelled = false
    let releaseTrailing: (() => void) | undefined
    const reply = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bytes))
        },
        pull(controller) {
          return new Promise<void>((resolve) => {
            releaseTrailing = () => {
              if (!cancelled) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ ...terminal, choices: [] })}\n\ndata: [DONE]\n\n`,
                  ),
                )
                controller.close()
              }
              resolve()
            }
          })
        },
        cancel() {
          cancelled = true
          releaseTrailing?.()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const reader = (await run.response(reply)).body?.getReader()
    if (!reader) throw new Error('missing body')
    const decoder = new TextDecoder()
    let consumed = ''
    while (!consumed.includes('"finish_reason":"stop"')) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      consumed += decoder.decode(next.value, { stream: true })
    }
    await reader?.cancel()
    expect(cancelled).toBe(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ outcome: 'completed', status: 200 })
    if (withUsage) expect(reports[0]?.usage).toEqual(expectedUsage)
    else expect(reports[0]).not.toHaveProperty('usage')
  })
}

test('a retry reports each physical send with a fresh attemptId', async () => {
  const { reports } = captureBilling()
  const run = await setup('deepseek')
  await run.send()
  await (await run.response(new Response('busy', { status: 429 }))).text()
  await trigger(run.host, 'retry', {
    ...run.scoped,
    attempt: 2,
    error: { type: 'provider.error', message: 'busy', status: 429 },
    decision: { retry: true, delay: 0 },
  })
  await run.send()
  await (await run.response(chatResponse('deepseek'))).text()
  expect(reports).toHaveLength(2)
  expect(reports.map((report) => report.outcome)).toEqual([
    'failed',
    'completed',
  ])
  expect(reports[1]?.attempt).toBe(2)
  expect(reports[0]?.attempt_id).not.toBe(reports[1]?.attempt_id)
})

test('xAI WebSocket reports the completed Responses frame once', async () => {
  const { reports } = captureBilling()
  const run = await setup('xai')
  await trigger(run.host, 'experimental.ws.handshake', {
    ...run.scoped,
    url: 'wss://api.x.ai/v1/responses',
    headers: { authorization: `Bearer ${placeholderSecret('xai')}` },
  })
  const frame = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'xai-response',
      model: 'sent-model',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  })
  await trigger(run.host, 'experimental.ws.receive', { ...run.scoped, frame })
  expect(reports).toEqual([
    {
      kind: 'billing',
      attempt_id: expect.any(String),
      request_kind: 'primary',
      credential_id: 'oauth:xai',
      account_id: 'account-1',
      provider: 'xai',
      model: 'sent-model',
      outcome: 'completed',
      provider_response_id: 'xai-response',
      charge_basis: 'metered_api',
      usage: expectedUsage,
      cache: { implicit: true },
    },
  ])
})
