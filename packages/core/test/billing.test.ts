import { expect, test } from 'bun:test'
import {
  BillingAttempt,
  billingUsage,
  observeBillingResponse,
} from '../src/billing.ts'
import { supportedProviders } from '../src/providers.ts'
import { createFetch, fixtureEntries } from '../test-entry.ts'
import { captureBilling } from './billing-fixtures.ts'
import { bearer, harness, placeholder } from './fakes.ts'

test('disabled billing observer preserves response identity without taking a reader or parsing JSON', () => {
  const response = new Response('not JSON')
  Object.defineProperty(response, 'body', {
    get() {
      throw new Error('billing took a reader')
    },
  })
  expect(observeBillingResponse(undefined, response)).toBe(response)
  expect(response.bodyUsed).toBe(false)
})

test.each(supportedProviders)(
  '$service has explicit, provider-true usage semantics',
  (entry) => {
    const result = billingUsage(entry, {
      usage: {
        prompt_tokens: 100,
        input_tokens: 90,
        completion_tokens: 20,
        output_tokens: 15,
        prompt_cache_hit_tokens: 40,
        cached_input_tokens: 30,
        prompt_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
        input_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 5 },
        reasoning_tokens: 7,
      },
      perf_metrics: { 'cached-prompt-tokens': 35 },
    })
    const expected: Record<string, unknown> =
      entry.service === 'typesafe'
        ? { input: 90, output: 15 }
        : {
            input: 75,
            output: 20,
            cacheRead: 25,
            reasoning: 5,
            reasoningIncludedInOutput: true,
          }
    // These values are deliberately independent of the table's extraction code.
    if (entry.service === 'deepseek')
      Object.assign(expected, { input: 60, cacheRead: 40 })
    if (entry.service === 'fireworks')
      Object.assign(expected, { input: 65, cacheRead: 35 })
    if (entry.service === 'inception')
      Object.assign(expected, { input: 70, cacheRead: 30, reasoning: 7 })
    if (entry.service === 'openrouter' || entry.service === 'kimi-coding')
      Object.assign(expected, { input: 65, cacheWrite: 10 })
    expect(result).toEqual(expected)
    expect(billingUsage(entry, { usage: {} })).toBeUndefined()
  },
)

test('OpenCode token accounting wins over generic totals and preserves write lifetimes and measured zero', () => {
  const entry = supportedProviders.find((row) => row.service === 'opencode-go')
  if (!entry) throw new Error('missing Go')
  expect(
    billingUsage(entry, {
      usage: {
        prompt_tokens: 999,
        completion_tokens: 999,
        opencode: {
          tokens: {
            input: 10,
            cache_read: 20,
            cache_write_5m: 3,
            cache_write_1h: 4,
            output: 8,
            reasoning: 0,
          },
        },
      },
    }),
  ).toEqual({
    input: 10,
    cacheRead: 20,
    cacheWrite: 7,
    cacheWrite5m: 3,
    cacheWrite1h: 4,
    output: 8,
    reasoning: 0,
    reasoningIncludedInOutput: true,
  })
})

test('a prompt total with missing cache metrics remains input, not an invented cache zero', () => {
  const entry = supportedProviders.find((row) => row.service === 'fireworks')
  if (!entry) throw new Error('missing fireworks')
  expect(
    billingUsage(entry, {
      usage: { prompt_tokens: 100, completion_tokens: 0 },
    }),
  ).toEqual({ input: 100, output: 0, reasoningIncludedInOutput: true })
})

test('TypeSafe non-streaming JSON reports at body end and ignores undocumented counters', async () => {
  const { reports } = captureBilling(true)
  const entry = supportedProviders.find((row) => row.service === 'typesafe')
  if (!entry) throw new Error('missing typesafe')
  const record = new BillingAttempt(
    entry,
    'typesafe',
    'session',
    'generate',
    'system-one',
    {
      credentialId: 'apikey:typesafe',
      credentialType: 'api_key',
      accountIdentitySource: 'none',
      accessToken: 'secret',
      recordVersion: 1,
      expiresAtMs: null,
    },
  )
  const response = observeBillingResponse(
    record,
    Response.json({
      usage: { input_tokens: 12, output_tokens: 3, cached_tokens: 999 },
    }),
  )
  expect(reports).toEqual([])
  await response.json()
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    outcome: 'completed',
    request_kind: 'generate',
    usage: { input: 12, output: 3 },
    cache: { warming: { on: false, stop_reason: 'unsupported' } },
  })
})

function streamAttempt(service: string) {
  const entry = supportedProviders.find((row) => row.service === service)
  if (!entry) throw new Error('missing provider')
  return new BillingAttempt(
    entry,
    service,
    'session',
    'primary',
    'sent-model',
    {
      credentialId: `apikey:${service}`,
      credentialType: 'api_key',
      accountIdentitySource: 'none',
      accessToken: 'secret',
      recordVersion: 1,
      expiresAtMs: null,
    },
  )
}

test('split prompt and cached counts derive uncached input once at report time', () => {
  const { reports } = captureBilling()
  const record = streamAttempt('cerebras')
  record.event({ usage: { prompt_tokens: 100, completion_tokens: 20 } })
  record.event({ usage: { prompt_tokens_details: { cached_tokens: 40 } } })
  record.done()
  record.bodyEnd(true, 200)
  expect(reports).toHaveLength(1)
  expect(reports[0]?.usage).toEqual({
    input: 60,
    output: 20,
    cache_read: 40,
    reasoning_included_in_output: true,
  })
})

test('split OpenCode write lifetimes are summed from their latest raw counts', () => {
  const { reports } = captureBilling()
  const record = streamAttempt('opencode-go')
  record.event({
    usage: { opencode: { tokens: { input: 10, cache_write_5m: 3 } } },
  })
  record.event({
    usage: { opencode: { tokens: { cache_write_1h: 4, output: 8 } } },
  })
  record.done()
  record.bodyEnd(true, 200)
  expect(reports).toHaveLength(1)
  expect(reports[0]?.usage).toEqual({
    input: 10,
    output: 8,
    cache_write: 7,
    cache_write_5m: 3,
    cache_write_1h: 4,
    reasoning_included_in_output: true,
  })
})

test.each(['terminal-redirect', 'transport-error', 'redirect-limit'] as const)(
  'core still reports a send ending in %s',
  async (mode) => {
    const { reports } = captureBilling()
    const h = await harness()
    const entry = fixtureEntries[0]
    if (!entry) throw new Error('missing fixture')
    const fetch = createFetch({
      entry,
      placeholder,
      consumer: h.consumer,
      routing: {
        sessionId: 'session',
        provider: 'fixture-a',
        modelId: 'sent-model',
      },
      billing: (receipt) =>
        new BillingAttempt(
          entry,
          'fixture-a',
          'session',
          'primary',
          'sent-model',
          receipt,
        ),
      fetch: async () => {
        if (mode === 'transport-error') throw new Error('transport failed')
        return new Response('redirect', {
          status: 307,
          headers: {
            location:
              mode === 'terminal-redirect'
                ? 'https://other.invalid/next'
                : '/again',
          },
        })
      },
    })
    const reply = fetch('https://fixture.invalid/start', { headers: bearer })
    if (mode === 'terminal-redirect') await (await reply).text()
    else
      await expect(reply).rejects.toThrow(
        mode === 'transport-error' ? 'transport failed' : 'redirect-limit',
      )
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      outcome: 'failed',
      model: 'sent-model',
      ...(mode !== 'transport-error' ? { status: 307 } : {}),
    })
    if (mode === 'transport-error')
      expect(reports[0]).not.toHaveProperty('status')
  },
)
