import { pluginId, startupStep } from '@cortexkit/claustrum-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { PluginModule } from '@opencode-ai/plugin'
import legacy from './index.ts'
import { setupServer } from './v2/setup.ts'
import { productionDeps } from './v2/vault.ts'

// OpenCode 2 loads this entry and calls `setup`; OpenCode 1 reads `server`
// from whichever entry it loads, so the legacy hooks stay reachable here too.
const claustrumAuth = {
  id: pluginId,
  server: legacy.server,
  setup: async (ctx: Plugin.Context) =>
    startupStep('opencode-start', async () =>
      setupServer(ctx, await productionDeps()),
    ),
} satisfies Plugin.Plugin & PluginModule

export default claustrumAuth
