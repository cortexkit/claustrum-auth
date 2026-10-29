// Only the e2e smoke test loads this entry. The production runner cannot opt
// into loopback origins or the file-controlled fake vault through CLI flags.
import path from 'node:path'
import {
  createTestCore,
  supportedProviders,
} from '../packages/core/test-entry.ts'
import { opencode1Hosts } from '../packages/opencode/src/v1/plugin.ts'
import { setupServer } from '../packages/opencode/src/v2/setup.ts'
import { fixtureClient } from '../packages/opencode/test/e2e/fixture-plugin.ts'
import { createPiExtension } from '../packages/pi/src/extension.ts'

const dir = process.env.CLAUSTRUM_AUTH_E2E_DIR ?? ''
const origin = process.env.CLAUSTRUM_AUTH_E2E_ORIGIN ?? ''
const table = supportedProviders
  .filter((e) => e.service === 'cerebras')
  .map((e) => ({ ...e, origins: [origin] }))
const client = fixtureClient(dir)
const createCore: typeof createTestCore = (options) =>
  createTestCore(
    {
      ...options,
      onError: (error) =>
        console.error(
          'fake core error',
          error instanceof Error ? error.name : typeof error,
        ),
    },
    table,
  )
const plugin =
  process.env.LIVE_SMOKE_TEST_HOST === 'pi'
    ? createPiExtension({
        createCore,
        connect: async () => client,
        syncIntervalMs: 100,
      })
    : process.env.LIVE_SMOKE_TEST_HOST === 'opencode1'
      ? {
          id: 'live-smoke-test',
          server: (input: Parameters<typeof opencode1Hosts>[1]) =>
            opencode1Hosts(
              {
                table,
                createCore,
                stateDir: () => path.join(dir, 'state'),
                isCustodyActive: async () => true,
                connect: async () => client,
              },
              input,
            ),
        }
      : {
          id: 'live-smoke-test',
          setup: (ctx: Parameters<typeof setupServer>[0]) =>
            setupServer(ctx, {
              table,
              authority: async () => 'vault',
              createCore: (facts) =>
                createCore({
                  facts,
                  stateDir: path.join(dir, 'state'),
                  tokenPath: process.env.LIVE_SMOKE_TEST_TOKEN_PATH ?? '',
                  isCustodyActive: async () => true,
                  connect: async () => client,
                }),
            }),
        }
export default plugin
