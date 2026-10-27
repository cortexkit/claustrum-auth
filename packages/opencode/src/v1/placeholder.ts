// OpenCode 1 decodes auth.json entries without unknown fields, so ownership can
// only live in the key value. The value is fixed per provider, carries no
// secret, and is always compared byte for byte, never by prefix.
export function placeholderFor(provider: string): string {
  return `cortexkit-claustrum-auth:v1:${provider}`
}

export type StoredEntry = Record<string, unknown> | undefined

// Only an entry that is exactly `{ type: 'api', key: <placeholder> }` belongs
// to the plugin. An entry with any extra field was written by someone else.
export function isPlaceholderEntry(
  entry: StoredEntry,
  provider: string,
): boolean {
  if (!entry) return false
  const keys = Object.keys(entry).sort()
  return (
    keys.length === 2 &&
    keys[0] === 'key' &&
    keys[1] === 'type' &&
    entry.type === 'api' &&
    entry.key === placeholderFor(provider)
  )
}
