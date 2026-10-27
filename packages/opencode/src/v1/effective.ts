import { isPlaceholderEntry, type StoredEntry } from './placeholder.js'

// The environment exactly as OpenCode 1 reads provider keys from it: a plain
// object copy of `process.env`. Node and Bun look up `process.env` without
// regard to case on Windows, but a copied object does not, so the host misses
// `Fixture_A_Api_Key` when the provider names `FIXTURE_A_API_KEY`. Looking up
// names in the same kind of copy keeps this check in agreement with the host.
export function hostEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string | undefined>> {
  return { ...source }
}

export type EffectiveCredential =
  | { source: 'stored' }
  | { source: 'env'; variable: string }
  | { source: 'config' }

export interface EffectiveInput {
  provider: string
  stored: StoredEntry
  env: Readonly<Record<string, string | undefined>>
  envNames: readonly string[]
  configApiKey: boolean
}

// A user credential that OpenCode 1 would use for the provider, if any. The
// plugin never writes its placeholder over one of these and never serves a
// request while one is shadowed by a stored placeholder.
export function effectiveCredential(
  input: EffectiveInput,
): EffectiveCredential | undefined {
  if (input.configApiKey) return { source: 'config' }
  if (input.stored && !isPlaceholderEntry(input.stored, input.provider))
    return { source: 'stored' }
  const variable = shadowedVariable(input.env, input.envNames)
  if (variable) return { source: 'env', variable }
  return undefined
}

export function shadowedVariable(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  // `Object.hasOwn` keeps the lookup exact: no prototype keys, no case folding.
  return names.find((name) => Object.hasOwn(env, name) && !!env[name])
}
