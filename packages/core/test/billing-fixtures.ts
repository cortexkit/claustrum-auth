import { afterEach } from 'bun:test'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, symbol, original)
  else Reflect.deleteProperty(globalThis, symbol)
})

export function captureBilling(
  keepWarm = false,
  accountFor = async ({ provider }: { provider: string }) => ({
    account_id: provider === 'fixture-a' ? 'account-a' : 'account-1',
  }),
) {
  const reports: Record<string, unknown>[] = []
  const sessions: string[] = []
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: (session: string) => {
      sessions.push(session)
      return {
        accountFor,
        report: (report: Record<string, unknown>) => {
          reports.push(report)
        },
        cache: () => (keepWarm ? { keep_warm: 'always' } : null),
      }
    },
  })
  return { reports, sessions }
}

// DeepSeek and Cerebras document these final-chunk fields. Cache writes are
// intentionally absent, so the expected report cannot silently invent zeroes.
export function chatChunks(provider: 'deepseek' | 'cerebras') {
  return [
    {
      id: 'reply-1',
      model: 'served-model',
      choices: [{ delta: { content: 'hello' }, finish_reason: null }],
    },
    {
      id: 'reply-1',
      model: 'served-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        ...(provider === 'deepseek'
          ? { prompt_cache_hit_tokens: 40 }
          : { prompt_tokens_details: { cached_tokens: 40 } }),
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  ]
}

export function chatResponse(provider: 'deepseek' | 'cerebras') {
  return new Response(
    `${chatChunks(provider)
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

export const expectedUsage = {
  input: 60,
  output: 20,
  cache_read: 40,
  reasoning: 5,
  reasoning_included_in_output: true,
}
