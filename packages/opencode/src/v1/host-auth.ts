import { readFile } from 'node:fs/promises'
import type { PluginInput } from '@opencode-ai/plugin'
import type { AuthApi } from './activation.js'
import type { StoredEntry } from './placeholder.js'

type HeyApiConfig = {
  baseUrl?: string
  fetch?: typeof fetch
  headers?: unknown
}

function headersOf(value: unknown): Headers {
  if (value instanceof Headers) return new Headers(value)
  const headers = new Headers()
  if (value && typeof value === 'object')
    for (const [name, item] of Object.entries(value))
      if (typeof item === 'string') headers.set(name, item)
  return headers
}

async function readStored(file: string): Promise<Record<string, unknown>> {
  // OpenCode 1 rewrites auth.json in place without a rename, so a read can
  // land on a partly written file. Retry a few times before giving up.
  for (let attempt = 0; ; attempt++) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    try {
      const value = JSON.parse(text) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

// OpenCode 1's own auth API. Reads come from the file the host itself reads;
// writes go through the host's routes, so the host stays the file's only
// writer: `PUT /auth/{id}` through the plugin client and `DELETE /auth/{id}`
// through the same transport (the plugin's v1 client has no provider remove).
export function hostAuthApi(
  client: PluginInput['client'],
  serverUrl: URL,
  authFile: () => string,
  env: () => Readonly<Record<string, string | undefined>> = () => process.env,
): AuthApi {
  return {
    async read(provider) {
      const value = (await readStored(authFile()))[provider]
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as StoredEntry)
        : undefined
    },
    async set(provider, entry) {
      const result = (await client.auth.set({
        path: { id: provider },
        body: entry,
      })) as { error?: unknown }
      if (result?.error)
        throw new Error(
          `claustrum-auth: OpenCode refused to store the vault placeholder for ${provider}.`,
        )
    },
    async remove(provider) {
      const hey = (
        client as unknown as { _client?: { getConfig(): HeyApiConfig } }
      )._client
      const config = hey?.getConfig() ?? {}
      const url = new URL(config.baseUrl ?? serverUrl)
      url.pathname = ['', 'auth', encodeURIComponent(provider)].join('/')
      const response = await (config.fetch ?? fetch)(
        new Request(url, {
          method: 'DELETE',
          headers: headersOf(config.headers),
        }),
      )
      await response.body?.cancel().catch(() => {})
      if (!response.ok)
        throw new Error(
          `claustrum-auth: OpenCode refused to remove the vault placeholder for ${provider}.`,
        )
    },
    contentOverride() {
      return !!env().OPENCODE_AUTH_CONTENT?.trim()
    },
  }
}
