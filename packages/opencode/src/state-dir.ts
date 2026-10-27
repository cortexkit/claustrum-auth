import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
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

function configIdentity(configDir: string): string {
  try {
    return realpathSync.native(configDir)
  } catch {
    return configDir
  }
}

const bindingError =
  'claustrum-auth: state directory belongs to a different OpenCode config directory.'

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
  await withLock(
    manifest,
    { name: 'config-dir', ttlMs: 10_000, timeoutMs: 10_000, renew: true },
    async (lock) => {
      let contents: string
      try {
        contents = await readFile(manifest, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeJsonAtomic(
          manifest,
          { version: 1, configDir: identity },
          { beforeRename: () => lock.assertOwned() },
        )
        return
      }
      let binding: unknown
      try {
        binding = JSON.parse(contents)
      } catch {
        throw new Error(bindingError)
      }
      if (
        !binding ||
        typeof binding !== 'object' ||
        !('version' in binding) ||
        binding.version !== 1 ||
        !('configDir' in binding) ||
        binding.configDir !== identity
      )
        throw new Error(bindingError)
    },
  )
  return stateDir
}
