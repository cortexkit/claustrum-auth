import {
  createCore,
  pluginId,
  supportedProviders,
} from '@cortexkit/claustrum-auth-core'
import type { PluginModule } from '@opencode-ai/plugin'
import { opencode1Hosts } from './v1/plugin.js'

// The OpenCode 1 entry. Its id is the claustrum-auth plugin's own and never the
// parked Claustrum plugin's `opencode-claustrum`.
const claustrumAuth = {
  id: pluginId,
  server: async (input) =>
    opencode1Hosts({ table: supportedProviders, createCore }, input),
} satisfies PluginModule

export default claustrumAuth
