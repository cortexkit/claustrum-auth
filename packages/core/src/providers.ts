import type {
  ClassifyingClaustrumFamily,
  VaultRowFacts,
} from '@cortexkit/common-auth/claustrum'

export type Host = 'opencode1' | 'opencode2' | 'pi'
export type ProviderClass = 'A' | 'B' | 'C' | 'D'
export interface ProviderEntry {
  service: string
  // The fleet's provider ids for this service: the vocabulary vault rows carry
  // in `provider_ids`, which fleet routing and pricing also use. They are not
  // host ids; `hosts` maps the service to each host's own id.
  ids: readonly string[]
  hosts: Partial<Record<Host, string>>
  // Exact vault credential ids served by this entry when the row carries no
  // provider id at all. Never a prefix or pattern; see the cline-pass entry.
  credentialIds?: readonly string[]
  class: ProviderClass
  origins: readonly string[]
  // Origins a WebSocket handshake may carry the key to (`wss` only), on hosts
  // whose driver opens a socket for this provider: today only OpenCode 2's
  // xAI driver. Kept apart from `origins` so an HTTP request is never allowed
  // to a socket origin, nor a handshake to an HTTP one. Absent: every owned
  // handshake of the provider is refused before any vault read.
  handshakeOrigins?: readonly string[]
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
// A vault row names its service by fleet id (`ids`); the plugin maps that id
// to the running host's id (`hosts`). The vault owner never retags rows for
// the plugin, so a fleet id this table does not know is refused as
// `unsupported-provider` rather than guessed.
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
    // Cline's documented base URL is `https://api.cline.bot/api/v1`.
    //
    // The vault row `apikey:cline-pass` deliberately carries no provider id:
    // with one, fleet routing picked it and sent fleet workers to it. The row
    // stays unmapped so fleet routing never picks it, and the plugin serves it
    // through this exact credential id instead, only while the row has no
    // provider ids.
    service: 'cline-pass',
    ids: ['cline-pass'],
    credentialIds: ['apikey:cline-pass'],
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
    // The fleet id is `fireworks-ai`; OpenCode's id is `fireworks-ai` and
    // Pi's is `fireworks`.
    service: 'fireworks',
    ids: ['fireworks-ai'],
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
    // The fleet id is `kimi-code-plan-global`; OpenCode's id is
    // `kimi-for-coding` and Pi's is `kimi-coding`.
    service: 'kimi-coding',
    ids: ['kimi-code-plan-global'],
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
  {
    // An OAuth row: the vault serves a minted inference key with an expiry,
    // which custody requires of every OAuth read (docs/providers.md, "Meta").
    service: 'meta',
    ids: ['meta'],
    hosts: { opencode1: 'meta', opencode2: 'meta', pi: 'meta' },
    class: 'A',
    origins: ['https://api.meta.ai'],
  },
  {
    // OpenCode 1 and Pi send xAI requests over HTTP through the plugin's
    // fetch. OpenCode 2's built-in xAI plugin opens a WebSocket by default,
    // so there the key also goes into the handshake to `wss://api.x.ai`
    // (docs/providers.md, "xAI on OpenCode 2"); the HTTP fallback the host
    // takes after a failed handshake is served like any other request.
    service: 'xai',
    ids: ['xai'],
    hosts: { opencode1: 'xai', opencode2: 'xai', pi: 'xai' },
    class: 'A',
    origins: ['https://api.x.ai'],
    handshakeOrigins: ['wss://api.x.ai'],
  },
  {
    // Each model picks its own driver. Only models whose driver sends the key
    // as `Authorization: Bearer` are served; the Anthropic- and Google-shaped
    // models send it in `x-api-key` or `x-goog-api-key` and are refused per
    // request (docs/providers.md, "OpenCode Go").
    service: 'opencode-go',
    ids: ['opencode-go'],
    hosts: {
      opencode1: 'opencode-go',
      opencode2: 'opencode-go',
      pi: 'opencode-go',
    },
    class: 'A',
    origins: ['https://opencode.ai'],
  },
  {
    // OpenCode Zen, provider id `opencode`. Not on OpenCode 2, where the
    // built-in Console plugin reads the stored `opencode` credential outside
    // the request hooks (design section 5.2, class D). Per-model drivers as
    // opencode-go.
    service: 'opencode-zen',
    ids: ['opencode'],
    hosts: { opencode1: 'opencode', pi: 'opencode' },
    class: 'A',
    origins: ['https://opencode.ai'],
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
  const entry = row.providerIds.length
    ? entryForFleetIds(row.providerIds, table)
    : table.find((candidate) =>
        candidate.credentialIds?.includes(row.credentialId),
      )
  if (!entry) return refused('unmapped')
  if (typeof entry === 'string') return refused(entry)
  // The row names the service by fleet id; the host serves it under its own.
  const provider = entry.hosts[facts.host]
  if (!provider) return refused('not-on-this-host')
  if (!facts.catalog.includes(provider)) return refused('unknown-to-host')
  if (facts.host === 'opencode2' && facts.integrations?.[provider] !== provider)
    return refused('integration-mismatch')
  return { kind: 'mine', member: provider }
}

// The one entry every fleet id of a row belongs to, or the refusal that stops
// it. Ids of two services, or a known id beside an unknown one, would make a
// 401 ambiguous (design section 4.3), so they are refused, not split.
function entryForFleetIds(
  providerIds: readonly string[],
  table: readonly ProviderEntry[],
): ProviderEntry | RefusalCode {
  if (providerIds.some((id) => reservedProviders.some((r) => r === id)))
    return 'reserved-provider'
  const entries = providerIds.map((id) =>
    table.find((entry) => entry.ids.includes(id)),
  )
  const entry = entries.find((value) => value !== undefined)
  if (!entry) return 'unsupported-provider'
  if (entries.some((value) => value !== entry)) return 'mixed-services'
  return entry
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
