// A probe extension for the coexistence test: `/coexist-models` reports the
// model ids Pi's registry holds for each provider, after every extension has
// registered its providers.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function coexistProbe(pi: ExtensionAPI) {
  pi.registerCommand('coexist-models', {
    handler: async (_args, ctx) => {
      const byProvider: Record<string, string[]> = {}
      for (const model of ctx.modelRegistry.getAll()) {
        const ids = byProvider[model.provider] ?? []
        ids.push(model.id)
        byProvider[model.provider] = ids
      }
      for (const ids of Object.values(byProvider)) ids.sort()
      ctx.ui.notify(`coexist-models ${JSON.stringify(byProvider)}`, 'info')
    },
  })
}
