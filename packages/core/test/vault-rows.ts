import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'

/** Model-provider metadata as list_scoped returns it, not custody's internal type. */
export function apiKeyRow(
  id: string,
  providerIds: readonly string[],
  extra: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return {
    id,
    categories: ['llm-provider'],
    credentialType: 'apikey',
    authMethod: 'apikey',
    providerIds,
    serves: [],
    operations: ['read'],
    state: 'active',
    recordVersion: 1,
    createdAtMs: null,
    ...extra,
  }
}

export function oauthRow(
  id: string,
  providerIds: readonly string[],
  refreshAdapter: string,
  extra: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return apiKeyRow(id, providerIds, {
    credentialType: 'oauth',
    authMethod: 'oauth',
    refreshAdapter,
    ...extra,
  })
}

// Metadata observed on the operator's vault. `serves` names model families,
// not credential providers; only Cerebras's observed families matter here.
export const realVaultRows: ScopedInventoryRow[] = [
  apiKeyRow('apikey:cerebras', ['cerebras'], {
    serves: ['meta', 'qwen', 'openai'],
  }),
  apiKeyRow('apikey:cline-pass', []),
  apiKeyRow('apikey:opencode-go', ['opencode-go'], {
    planTier: 'go',
    planTierSource: 'operator',
    recordVersion: 2,
  }),
  apiKeyRow('apikey:opencode-zen', ['opencode']),
  oauthRow('oauth:cursor', [], 'cursor', {
    categories: ['cursor-native', 'llm-provider'],
  }),
  oauthRow('oauth:meta', ['meta'], 'meta'),
  apiKeyRow('apikey:missing-auth-method', ['cerebras'], {
    authMethod: undefined,
  }),
]
