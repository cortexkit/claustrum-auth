// The probe extension of the Pi spike. It is not the plugin: it measures what
// the plugin relies on, using only Pi's public extension API.
import { appendFileSync } from 'node:fs'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import type {
  ExtensionAPI,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent'

const log = process.env.SPIKE_LOG ?? ''
const record = (value: unknown) =>
  appendFileSync(log, `${JSON.stringify(value)}\n`)

const proxied = ['spike-completions', 'spike-responses'] as const

export default function spike(pi: ExtensionAPI) {
  pi.on('session_start', () => {
    for (const provider of proxied) {
      pi.registerProvider(provider, {
        api:
          provider === 'spike-completions'
            ? 'openai-completions'
            : 'openai-responses',
        streamSimple: (model, context, options) =>
          streamSimple(model, context, {
            ...options,
            fetch: (async (
              input: string | URL | Request,
              init?: RequestInit,
            ) => {
              const headers = new Headers(
                init?.headers ??
                  (input instanceof Request ? input.headers : undefined),
              )
              record({
                fetch: provider,
                url: input instanceof Request ? input.url : String(input),
                authorization: headers.get('authorization'),
                xApiKey: headers.get('x-api-key'),
              })
              headers.set('x-spike-fetch', provider)
              if (input instanceof Request)
                return fetch(new Request(input, { headers }))
              return fetch(input, { ...init, headers })
            }) as typeof fetch,
          }),
      })
    }
  })
  pi.registerCommand('spike-catalog', {
    handler: async (args, ctx) => {
      const [provider = '', api = ''] = args.trim().split(' ')
      const snapshot = () =>
        ctx.modelRegistry
          .getAll()
          .filter((model) => model.provider === provider)
          .map((model) => ({ ...model }))
          .sort((a, b) => a.id.localeCompare(b.id))
      const before = snapshot()
      pi.registerProvider(provider, {
        api: api as never,
        streamSimple,
        models: before
          .filter((model) => model.api === api)
          .map(
            ({ provider: _provider, ...model }) => model as ProviderModelConfig,
          ),
      })
      await ctx.modelRegistry.refresh()
      const owned = snapshot()
      // Pi merges a re-registration over the previous one and keeps fields it
      // leaves undefined, so this alone keeps the owned model list.
      pi.registerProvider(provider, { api: api as never, streamSimple })
      await ctx.modelRegistry.refresh()
      const merged = snapshot()
      pi.unregisterProvider(provider)
      pi.registerProvider(provider, { api: api as never, streamSimple })
      await ctx.modelRegistry.refresh()
      const restored = snapshot()
      record({ catalog: provider, before, owned, merged, restored })
      ctx.ui.notify('spike-catalog done', 'info')
    },
  })
}
