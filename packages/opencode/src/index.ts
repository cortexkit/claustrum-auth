import { pluginId } from '@cortexkit/claustrum-auth-core'
import type { PluginModule } from '@opencode-ai/plugin'

const claustrumAuth = {
  id: pluginId,
  server: async () => ({}),
} satisfies PluginModule

export default claustrumAuth
