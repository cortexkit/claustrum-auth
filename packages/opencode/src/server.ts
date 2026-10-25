import { pluginId } from '@cortexkit/claustrum-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { PluginModule } from '@opencode-ai/plugin'
import legacy from './index.ts'

const claustrumAuth = {
  id: pluginId,
  server: legacy.server,
  setup() {},
} satisfies Plugin.Plugin & PluginModule

export default claustrumAuth
