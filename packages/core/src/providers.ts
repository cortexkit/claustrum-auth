import type {
  ClassifyingClaustrumFamily,
  VaultRowFacts,
} from '@cortexkit/common-auth/claustrum'

export type Host = 'opencode1' | 'opencode2' | 'pi'
export type ProviderClass = 'A' | 'B' | 'C' | 'D'
export interface ProviderEntry {
  service: string
  ids: readonly string[]
  hosts: Partial<Record<Host, string>>
  class: ProviderClass
  origins: readonly string[]
  accountPath?: readonly string[]
}
export interface HostFacts {
  host: Host
  catalog: readonly string[]
  integrations?: Readonly<Record<string, string>>
}

// Enable a service only after each supported host proves bearer placement,
// origin and redirect refusal, and error redaction, then sends a real request
// with an enrolled vault credential.
export const supportedProviders: readonly ProviderEntry[] = []
export const reservedProviders = [
  'openai',
  'openai-codex',
  'anthropic',
  'anthropic-platform',
  'google',
] as const
export const refusalCodes = [
  'no-auth-method',
  'unmapped',
  'reserved-provider',
  'unsupported-provider',
  'mixed-services',
  'not-on-this-host',
  'host-id-missing',
  'unknown-to-host',
  'integration-mismatch',
] as const
export type RefusalCode = (typeof refusalCodes)[number]

export function classifyRow(
  row: VaultRowFacts,
  facts: HostFacts,
  table: readonly ProviderEntry[] = supportedProviders,
): ReturnType<ClassifyingClaustrumFamily<RefusalCode>['classify']> {
  const refused = (code: RefusalCode) => ({ kind: 'refused' as const, code })
  if (!row.providerIds) return refused('unmapped')
  if (
    row.authMethod === 'chatgpt' ||
    row.authMethod === 'antigravity' ||
    (row.credentialType === 'oauth' && row.refreshAdapter === 'anthropic')
  )
    return { kind: 'not-mine' }
  if (!row.authMethod) return refused('no-auth-method')
  if (!row.providerIds.length) return refused('unmapped')
  if (row.providerIds.some((id) => reservedProviders.some((r) => r === id)))
    return refused('reserved-provider')
  const entries = row.providerIds.map((id) =>
    table.find((entry) => entry.ids.includes(id)),
  )
  const entry = entries.find((value) => value !== undefined)
  if (!entry) return refused('unsupported-provider')
  if (entries.some((value) => value !== entry)) return refused('mixed-services')
  const provider = entry.hosts[facts.host]
  if (!provider) return refused('not-on-this-host')
  if (!row.providerIds.includes(provider)) return refused('host-id-missing')
  if (!facts.catalog.includes(provider)) return refused('unknown-to-host')
  if (facts.host === 'opencode2' && facts.integrations?.[provider] !== provider)
    return refused('integration-mismatch')
  return { kind: 'mine', member: provider }
}

export function classifyingFamily(
  facts: HostFacts,
  table: readonly ProviderEntry[] = supportedProviders,
): ClassifyingClaustrumFamily<RefusalCode> {
  return {
    category: 'llm-provider',
    refusalCodes,
    classify: (row) => classifyRow(row, facts, table),
  }
}

export function listedProviders(
  facts: HostFacts,
  table: readonly ProviderEntry[] = supportedProviders,
) {
  return table.filter((entry) => {
    const id = entry.hosts[facts.host]
    return (
      id &&
      !reservedProviders.some((r) => r === id) &&
      facts.catalog.includes(id) &&
      (facts.host !== 'opencode2' || facts.integrations?.[id] === id)
    )
  })
}
