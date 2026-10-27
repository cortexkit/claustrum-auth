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
// with an enrolled vault credential (design section 14.4, steps 1-6).
//
// Origins are the API hosts the provider's own documentation names. A path is
// never part of an origin, so `https://api.deepseek.com` also covers requests
// to `/v1/chat/completions`. Every host in the table sends the credential as
// `Authorization: Bearer`: Pi registers only providers whose models use
// `openai-completions` or `openai-responses`, and OpenCode passes the key to
// the provider's bearer driver.
//
// Sources per entry are recorded in `docs/providers.md`, with the exact page
// each one was taken from.
export const supportedProviders: readonly ProviderEntry[] = [
  {
    service: 'cerebras',
    ids: ['cerebras'],
    hosts: { opencode1: 'cerebras', opencode2: 'cerebras', pi: 'cerebras' },
    class: 'A',
    origins: ['https://api.cerebras.ai'],
  },
  {
    // Cline's documented base URL is `https://api.cline.bot/api/v1`; the vault
    // row for it carries no provider id, so the vault cannot map it to this
    // entry yet (docs/providers.md, "Not served yet").
    service: 'cline-pass',
    ids: ['cline-pass'],
    hosts: { opencode1: 'cline-pass', opencode2: 'cline-pass' },
    class: 'A',
    origins: ['https://api.cline.bot'],
  },
  {
    service: 'deepseek',
    ids: ['deepseek'],
    hosts: { opencode1: 'deepseek', opencode2: 'deepseek', pi: 'deepseek' },
    class: 'A',
    origins: ['https://api.deepseek.com'],
  },
  {
    // OpenCode's id is `fireworks-ai`; Pi's is `fireworks`. Both name one
    // service, so a vault row may carry both ids (section 4.3).
    service: 'fireworks',
    ids: ['fireworks-ai', 'fireworks'],
    hosts: {
      opencode1: 'fireworks-ai',
      opencode2: 'fireworks-ai',
      pi: 'fireworks',
    },
    class: 'A',
    origins: ['https://api.fireworks.ai'],
  },
  {
    service: 'inception',
    ids: ['inception'],
    hosts: { opencode1: 'inception', opencode2: 'inception' },
    class: 'A',
    origins: ['https://api.inceptionlabs.ai'],
  },
  {
    // The provider's documentation and its credential name say "kimi-code";
    // OpenCode's id is `kimi-for-coding` and Pi's is `kimi-coding`.
    service: 'kimi-coding',
    ids: ['kimi-for-coding', 'kimi-coding'],
    hosts: {
      opencode1: 'kimi-for-coding',
      opencode2: 'kimi-for-coding',
      pi: 'kimi-coding',
    },
    class: 'A',
    origins: ['https://api.kimi.com'],
  },
  {
    service: 'openrouter',
    ids: ['openrouter'],
    hosts: {
      opencode1: 'openrouter',
      opencode2: 'openrouter',
      pi: 'openrouter',
    },
    class: 'A',
    origins: ['https://openrouter.ai'],
  },
  {
    // OpenCode only: Pi registers `typesafe` with its `typesafe-system-one`
    // api, which does not take a caller fetch, so the plugin's fetch never
    // sees a typesafe request there.
    service: 'typesafe',
    ids: ['typesafe'],
    hosts: { opencode1: 'typesafe', opencode2: 'typesafe' },
    class: 'A',
    origins: ['https://api.typesafe.ai'],
  },
]
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
