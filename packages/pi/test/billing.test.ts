import { expect, test } from 'bun:test'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { supportedProviders } from '../../core/src/providers.ts'
import {
  captureBilling,
  chatResponse,
  expectedUsage,
} from '../../core/test/billing-fixtures.ts'
import { liveHarness, vaultRowFor } from '../../core/test/fakes.ts'
import { installVaultHost } from '../../core/test/host.ts'
import { createTestCore } from '../../core/test-entry.ts'
import { createPiExtension, placeholderKey } from '../src/extension.ts'
import { agentDir } from './harness.ts'

async function turn(
  provider: 'deepseek' | 'cerebras',
  ownKey = false,
  retry = false,
  redirect = false,
  onSemantics?: () => void,
  onReady?: () => void,
) {
  const base = supportedProviders.find((row) => row.service === provider)
  if (!base?.billing) throw new Error('missing provider')
  const entry = onSemantics
    ? {
        ...base,
        billing: new Proxy(base.billing, {
          get(target, key, receiver) {
            onSemantics()
            return Reflect.get(target, key, receiver)
          },
        }),
      }
    : base
  const h = await liveHarness(
    [
      vaultRowFor(entry, { accountId: 'account-1' }),
      ...(retry
        ? [
            vaultRowFor(entry, {
              id: `apikey:${provider}:second`,
              accountId: 'account-2',
            }),
          ]
        : []),
    ],
    'pi',
  )
  installVaultHost(h.client)
  const agent = await agentDir({
    enrolled: false,
    flags: { [provider]: { consented: true } },
  })
  process.env.PI_CODING_AGENT_DIR = agent.agent
  let registered: Record<string, unknown> | undefined
  const handlers: Record<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  > = {}
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers[name] = handler
    },
    registerCommand() {},
    unregisterProvider() {},
    registerProvider(_name: string, value: Record<string, unknown>) {
      registered = value
    },
  } as unknown as ExtensionAPI
  const context = {
    modelRegistry: {
      getAll: () => [{ provider, id: 'sent-model', api: 'openai-completions' }],
      refresh: async () => {},
    },
    ui: { notify() {} },
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'pi-session' },
  } as unknown as ExtensionContext
  createPiExtension({ createCore: (built) => createTestCore(built, [entry]) })(
    pi,
  )
  try {
    await handlers.session_start?.({}, context)
    onReady?.()
    const stream = registered?.streamSimple as (
      ...args: unknown[]
    ) => AssistantMessageEventStream
    if (!stream) throw new Error('missing registered stream')
    let sends = 0
    let includeUsage: unknown
    const reply = stream(
      {
        provider,
        id: 'sent-model',
        api: 'openai-completions',
        baseUrl: `${entry.origins[0]}/v1`,
        input: ['text'],
        output: ['text'],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 100,
      },
      { messages: [] },
      {
        sessionId: 'pi-session',
        apiKey: ownKey ? 'user-key' : placeholderKey(provider),
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          includeUsage = (await request.json()).stream_options
          expect(request.headers.get('authorization')).toBe(
            ownKey
              ? 'Bearer user-key'
              : `Bearer secret-apikey:${provider}${retry && sends > 0 ? ':second' : ''}-1`,
          )
          if (retry && ++sends === 1)
            return new Response('busy', {
              status: 429,
              headers: { 'retry-after': '120' },
            })
          if (redirect && ++sends === 1)
            return new Response(null, {
              status: 307,
              headers: { location: `${entry.origins[0]}/v1/redirected` },
            })
          return chatResponse(provider)
        },
      },
    )
    for await (const _event of reply) {
    }
    const message = await reply.result()
    expect(message.stopReason).toBe('stop')
    expect(includeUsage).toEqual({ include_usage: true })
    return message
  } finally {
    await handlers.session_shutdown?.({}, context)
  }
}

for (const provider of ['deepseek', 'cerebras'] as const) {
  test(`Pi ${provider} bills provider-true usage once with Pi's final responseId`, async () => {
    const { reports, sessions } = captureBilling()
    let parsed = 0
    const message = await turn(
      provider,
      false,
      false,
      false,
      () => {
        parsed++
      },
      () => {
        parsed = 0
      },
    )
    expect(parsed).toBeGreaterThan(0)
    expect(message.responseId).toBe('reply-1')
    expect(reports).toEqual([
      {
        kind: 'billing',
        attempt_id: expect.any(String),
        attempt: 1,
        request_kind: 'primary',
        credential_id: `apikey:${provider}`,
        account_id: 'account-1',
        provider,
        model: 'sent-model',
        outcome: 'completed',
        status: 200,
        provider_response_id: message.responseId,
        ...(provider === 'deepseek' ? { charge_basis: 'metered_api' } : {}),
        usage: expectedUsage,
        cache: { implicit: true },
      },
    ])
    expect(sessions.every((session) => session === 'pi-session')).toBe(true)
  })
}

test('Pi leaves a user key unbilled even when the routing accessor is installed', async () => {
  const { reports } = captureBilling()
  await turn('deepseek', true)
  expect(reports).toEqual([])
})

test('Pi reroute bills both physical sends with different UUIDs and attempts', async () => {
  const { reports } = captureBilling()
  await turn('deepseek', false, true)
  expect(reports).toHaveLength(2)
  expect(
    reports.map((report) => [report.attempt, report.status, report.outcome]),
  ).toEqual([
    [1, 429, 'failed'],
    [2, 200, 'completed'],
  ])
  expect(reports[0]?.attempt_id).not.toBe(reports[1]?.attempt_id)
})

test('Pi followed same-origin redirect reports only the completed model call', async () => {
  const { reports } = captureBilling()
  await turn('deepseek', false, false, true)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    status: 200,
    outcome: 'completed',
    usage: expectedUsage,
  })
})

test('Pi without an accessor never looks up usage semantics for a served request', async () => {
  Reflect.deleteProperty(globalThis, Symbol.for('cortexkit.routing'))
  let parsed = 0
  await turn(
    'deepseek',
    false,
    false,
    false,
    () => {
      parsed++
    },
    () => {
      parsed = 0
    },
  )
  expect(parsed).toBe(0)
})
