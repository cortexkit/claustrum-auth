import {
  createCore,
  type HostFacts,
  opencodeEnrollment,
  supportedProviders,
} from '@cortexkit/claustrum-auth-core'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  connectClaustrumScopedClient,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { opencodeStateDir } from '../state-dir.js'
import type { ServerDeps } from './setup.ts'

/** The published entry's runtime: the shipped table and the real vault. */
export async function productionDeps(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerDeps> {
  const stateDir = await opencodeStateDir(env)
  const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
  const authority = () => enrollmentAuthority(paths, opencodeEnrollment)
  return {
    table: supportedProviders,
    authority,
    createCore: (facts: HostFacts) =>
      createCore({
        facts,
        stateDir,
        tokenPath: paths.tokenPath,
        isCustodyActive: async () => (await authority()) === 'vault',
        connect: () =>
          connectClaustrumScopedClient({
            connectionFile: resolveClaustrumConnectionPath(),
            projectRoot: process.cwd(),
            storagePath: paths.tokenPath,
            // The client's default logger prints transport error classes to
            // stderr, which would land in the host's terminal.
            logger: () => {},
          }),
      }),
  }
}
