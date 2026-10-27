import { homedir } from 'node:os'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

// OpenCode 1's auth.json: `$XDG_DATA_HOME/opencode/auth.json`, else
// `<home>/.local/share/opencode/auth.json`, on every OS.
export function opencodeAuthFile(env: Env = process.env): string {
  const data = env.XDG_DATA_HOME?.trim()
    ? env.XDG_DATA_HOME
    : path.join(homedir(), '.local', 'share')
  return path.join(data, 'opencode', 'auth.json')
}
