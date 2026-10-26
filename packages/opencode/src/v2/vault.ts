import { homedir } from 'node:os'
import path from 'node:path'
import {
  createCore,
  type HostFacts,
  opencodeEnrollment,
} from '@cortexkit/claustrum-auth-core'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  connectClaustrumScopedClient,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import type { ServerDeps } from './setup.ts'

/**
 * OpenCode's configuration directory, resolved the way the host does on every
 * OS: `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
 * `<home>/.config/opencode` (Windows included, where home is `USERPROFILE`).
 */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  return path.join(
    env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config'),
    'opencode',
  )
}

/**
 * The plugin's own owner-only state directory (enrollment token and state,
 * rosters), beside the host's configuration rather than inside it: the vault
 * library makes this directory private, which the host's own must not be.
 */
export function opencodeStateDir(env: NodeJS.ProcessEnv = process.env) {
  return path.join(opencodeConfigDir(env), 'claustrum-auth')
}

/** The published entry's runtime: the shipped table and the real vault. */
export function productionDeps(): ServerDeps {
  const stateDir = opencodeStateDir()
  const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
  const authority = () => enrollmentAuthority(paths, opencodeEnrollment)
  return {
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
