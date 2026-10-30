import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { startupRefusal, startupStep } from '@cortexkit/claustrum-auth-core'
import { withLock, writeJsonAtomic } from '@cortexkit/common-auth/fs'

type Env = Readonly<Record<string, string | undefined>>

// OpenCode uses the same XDG config and state defaults on every OS.
export function opencodeConfigDir(
  env: Env = process.env,
  home = homedir(),
): string {
  return path.resolve(
    env.OPENCODE_CONFIG_DIR?.trim() ||
      path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
  )
}

/**
 * The config folder's canonical spelling, whether or not it exists yet.
 *
 * A folder that does not exist yet is named by the canonical spelling of its
 * deepest existing parent plus the missing names. Otherwise the identity, and
 * with it the state key, would change once OpenCode creates the folder: an
 * alias such as a symlinked parent, macOS `/var` (really `/private/var`) or a
 * Windows 8.3 short name (`C:\Users\RUNNER~1`) only resolves to its real
 * spelling for a path that exists. Setup would then enroll in one state
 * folder and the host would look for the enrollment in another.
 */
function configIdentity(configDir: string): string {
  const missing: string[] = []
  let current = configDir
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing)
    } catch (error) {
      const parent = path.dirname(current)
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        parent === current
      )
        return configDir
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/** Resolve the shared OpenCode 1/2 state without creating it (setup preview). */
export function resolveOpencodeStateDir(
  env: Env = process.env,
  home = homedir(),
): string {
  const configDir = opencodeConfigDir(env, home)
  const identity = configIdentity(configDir)
  const key =
    identity === configIdentity(path.resolve(home, '.config', 'opencode'))
      ? 'opencode'
      : `opencode-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
  return path.resolve(
    env.XDG_STATE_HOME || path.join(home, '.local', 'state'),
    'cortexkit',
    'claustrum-auth',
    key,
  )
}

/** Resolves and binds the shared OpenCode 1/2 state before any runtime writes. */
export async function opencodeStateDir(
  env: Env = process.env,
  home = homedir(),
): Promise<string> {
  const identity = configIdentity(opencodeConfigDir(env, home))
  const stateDir = resolveOpencodeStateDir(env, home)
  const manifest = path.join(stateDir, 'config-dir.json')
  // Serialize first use so two hosts cannot replace a binding they never read.
  await startupStep('opencode-state-lock', () =>
    withLock(
      manifest,
      { name: 'config-dir', ttlMs: 10_000, timeoutMs: 10_000, renew: true },
      async (lock) => {
        let contents: string
        try {
          contents = await readFile(manifest, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw startupRefusal('opencode-state-read', error)
          await startupStep('opencode-state-write', () =>
            writeJsonAtomic(
              manifest,
              { version: 1, configDir: identity },
              { beforeRename: () => lock.assertOwned() },
            ),
          )
          return
        }
        let binding: unknown
        try {
          binding = JSON.parse(contents)
        } catch {
          throw startupRefusal('opencode-binding')
        }
        if (
          !binding ||
          typeof binding !== 'object' ||
          !('version' in binding) ||
          binding.version !== 1 ||
          !('configDir' in binding) ||
          binding.configDir !== identity
        )
          throw startupRefusal('opencode-binding')
      },
    ),
  )
  return stateDir
}
