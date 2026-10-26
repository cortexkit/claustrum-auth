import { homedir } from 'node:os'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

// OpenCode's config directory, as section 3.1 of the design resolves it on
// every OS (xdg-basedir does not special-case Windows).
export function opencodeConfigDir(env: Env = process.env): string {
  if (env.OPENCODE_CONFIG_DIR?.trim())
    return path.resolve(env.OPENCODE_CONFIG_DIR)
  if (env.XDG_CONFIG_HOME?.trim())
    return path.join(env.XDG_CONFIG_HOME, 'opencode')
  return path.join(homedir(), '.config', 'opencode')
}

// The plugin's own owner-only state directory: enrollment token and state,
// rosters and the persisted release flags. common-auth's writers create it.
export function pluginStateDir(env: Env = process.env): string {
  return path.join(opencodeConfigDir(env), 'claustrum-auth')
}

// OpenCode 1's auth.json: `$XDG_DATA_HOME/opencode/auth.json`, else
// `<home>/.local/share/opencode/auth.json`, on every OS.
export function opencodeAuthFile(env: Env = process.env): string {
  const data = env.XDG_DATA_HOME?.trim()
    ? env.XDG_DATA_HOME
    : path.join(homedir(), '.local', 'share')
  return path.join(data, 'opencode', 'auth.json')
}
