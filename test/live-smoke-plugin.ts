// Only the e2e smoke test loads this entry. The production runner cannot opt
// into loopback origins or the file-controlled fake vault through CLI flags.
import {
  createTestCore,
  supportedProviders,
} from '../packages/core/test-entry.ts'
import { opencodeStateDir } from '../packages/opencode/src/state-dir.ts'
import { opencode1Hosts } from '../packages/opencode/src/v1/plugin.ts'
import { setupServer } from '../packages/opencode/src/v2/setup.ts'
import {
  enrollmentAuthority,
  fixtureClient,
  hostEnrollmentPaths,
} from '../packages/opencode/test/e2e/fixture-plugin.ts'
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
    : {
        id: 'live-smoke-test',
        server: (input: Parameters<typeof opencode1Hosts>[1]) =>
          opencode1Hosts(
            {
              table,
              createCore,
              connect: async () => client,
            },
            input,
          ),
      }

export const serverPlugin = {
  id: 'live-smoke-test',
  async setup(ctx: Parameters<typeof setupServer>[0]) {
    const stateDir = await opencodeStateDir()
    const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
    const authority = () =>
      enrollmentAuthority(paths, 'claustrum-auth-opencode')
    return setupServer(ctx, {
      table,
      authority,
      createCore: (facts) =>
        createCore({
          facts,
          stateDir,
          tokenPath: paths.tokenPath,
          isCustodyActive: async () => (await authority()) === 'vault',
          connect: async () => client,
        }),
    })
  },
}
export default plugin
