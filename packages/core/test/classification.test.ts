import { expect, test } from 'bun:test'
import {
  ClaustrumScopedCustody,
  type VaultRowFacts,
} from '@cortexkit/common-auth/claustrum'
import {
  catalogEntries,
  classifyingFamily,
  classifyRow,
  fixtureEntries,
  type Host,
  type HostFacts,
  reservedProviders,
  supportedProviders,
} from '../test-entry.ts'
import { harness, row } from './fakes.ts'

const hosts: Host[] = ['opencode1', 'opencode2', 'pi']
function facts(host: Host): HostFacts {
  const catalog = catalogEntries.flatMap((entry) =>
    entry.hosts[host] ? [entry.hosts[host] as string] : [],
  )
  return {
    host,
    catalog,
    integrations: Object.fromEntries(catalog.map((id) => [id, id])),
  }
}
function fact(
  providerIds: string[],
  extra: Partial<VaultRowFacts> = {},
): VaultRowFacts {
  return {
    credentialId: 'opaque-id',
    credentialType: 'api_key',
    categories: ['llm-provider'],
    authMethod: 'api-key',
    providerIds,
    ...extra,
  }
}

test('31 inventory rows classify per host without parsing credential ids', () => {
  const rows: {
    value: VaultRowFacts
    expected: (host: Host) => ReturnType<typeof classifyRow>
  }[] = []
  for (const [count, method, adapter] of [
    [5, 'oauth', 'anthropic'],
    [3, 'chatgpt', undefined],
    [1, 'antigravity', undefined],
  ] as const) {
    for (let i = 0; i < count; i++)
      rows.push({
        value: fact(['reserved-or-irrelevant'], {
          credentialType: 'oauth',
          authMethod: method,
          refreshAdapter: adapter,
        }),
        expected: () => ({ kind: 'not-mine' }),
      })
  }
  for (const [count, id] of [
    [4, 'anthropic-platform'],
    [2, 'openai'],
    [1, 'google'],
  ] as const) {
    for (let i = 0; i < count; i++)
      rows.push({
        value: fact([id]),
        expected: () => ({ kind: 'refused', code: 'reserved-provider' }),
      })
  }
  for (const _ of ['muse', 'cursor'])
    rows.push({
      value: fact([]),
      expected: () => ({ kind: 'refused', code: 'unmapped' }),
    })
  for (const id of [
    'meta',
    'xai',
    'cerebras',
    'cline-pass',
    'deepseek',
    'fireworks-ai',
    'inception',
    'kimi-code-plan-global',
    'openrouter',
    'typesafe',
    'cloudflare-workers-ai',
    'opencode-go',
    'opencode',
  ]) {
    rows.push({
      value: fact([id]),
      expected: (host) => {
        if (
          (host === 'opencode2' && ['xai', 'opencode'].includes(id)) ||
          (host === 'pi' &&
            ['cline-pass', 'inception', 'typesafe'].includes(id))
        )
          return { kind: 'refused', code: 'not-on-this-host' }
        // Rows carry fleet ids; two services have other ids on the hosts.
        const member =
          host === 'pi'
            ? {
                'fireworks-ai': 'fireworks',
                'kimi-code-plan-global': 'kimi-coding',
              }[id]
            : { 'kimi-code-plan-global': 'kimi-for-coding' }[id]
        return { kind: 'mine', member: member ?? id }
      },
    })
  }
  expect(rows).toHaveLength(31)
  for (const host of hosts)
    for (const item of rows)
      expect(classifyRow(item.value, facts(host), catalogEntries)).toEqual(
        item.expected(host),
      )
  expect(
    catalogEntries.find((entry) => entry.service === 'cloudflare-workers-ai')
      ?.class,
  ).toBe('B')
})

// Vault rows name services by fleet id (the ids fleet routing and pricing
// use), and the vault owner never retags a row for the plugin. The plugin maps
// each fleet id to the running host's id, and refuses an id it has no mapping
// for instead of guessing.
test('classification maps fleet ids to each host id and refuses host ids and unknown fleet ids', () => {
  const run = (ids: string[], host: Host) =>
    classifyRow(fact(ids), facts(host), catalogEntries)
  for (const host of hosts) {
    expect(run(['fireworks-ai'], host)).toEqual({
      kind: 'mine',
      member: host === 'pi' ? 'fireworks' : 'fireworks-ai',
    })
    expect(run(['kimi-code-plan-global'], host)).toEqual({
      kind: 'mine',
      member: host === 'pi' ? 'kimi-coding' : 'kimi-for-coding',
    })
    // A host's own id is not a fleet id.
    for (const hostId of ['fireworks', 'kimi-for-coding', 'kimi-coding'])
      expect(run([hostId], host)).toEqual({
        kind: 'refused',
        code: 'unsupported-provider',
      })
    expect(run(['a-fleet-id-the-table-lacks'], host)).toEqual({
      kind: 'refused',
      code: 'unsupported-provider',
    })
  }
  expect(run(['fireworks-ai', 'new-alias'], 'pi')).toEqual({
    kind: 'refused',
    code: 'mixed-services',
  })
  expect(run(['opencode', 'opencode-go'], 'pi')).toEqual({
    kind: 'refused',
    code: 'mixed-services',
  })
})

test('classification gates are ordered and refusal codes are closed', () => {
  const run = (value: VaultRowFacts, changes: Partial<HostFacts> = {}) =>
    classifyRow(value, { ...facts('opencode2'), ...changes }, catalogEntries)
  expect(
    run(fact([], { providerIds: undefined, authMethod: undefined })),
  ).toEqual({ kind: 'refused', code: 'unmapped' })
  expect(run(fact(['meta'], { authMethod: undefined }))).toEqual({
    kind: 'refused',
    code: 'no-auth-method',
  })
  expect(run(fact(['unknown']))).toEqual({
    kind: 'refused',
    code: 'unsupported-provider',
  })
  expect(run(fact(['meta']), { catalog: [] })).toEqual({
    kind: 'refused',
    code: 'unknown-to-host',
  })
  expect(run(fact(['meta']), { integrations: { meta: 'different' } })).toEqual({
    kind: 'refused',
    code: 'integration-mismatch',
  })
})

test('reserved matrix never admits reserved providers alone or beside others', () => {
  for (const host of hosts)
    for (const reserved of reservedProviders) {
      for (const ids of [[reserved], ['meta', reserved]])
        expect(classifyRow(fact(ids), facts(host), catalogEntries)).toEqual({
          kind: 'refused',
          code: 'reserved-provider',
        })
    }
  for (const entry of [
    ...supportedProviders,
    ...fixtureEntries,
    ...catalogEntries,
  ])
    for (const id of [...entry.ids, ...Object.values(entry.hosts)])
      expect(reservedProviders as readonly string[]).not.toContain(id)
  expect(supportedProviders.map((entry) => entry.service)).toEqual([
    'cerebras',
    'cline-pass',
    'deepseek',
    'fireworks',
    'inception',
    'kimi-coding',
    'openrouter',
    'typesafe',
    'meta',
    'xai',
    'opencode-go',
    'opencode-zen',
  ])
})

test('library gates category read and credential type and normalizes invalid classifications', async () => {
  const h = await harness([
    row('no-read', { operations: [] }),
    row('wrong-category', { categories: ['other'] }),
    row('refused', { providerIds: [] }),
    row('not-mine', { authMethod: 'chatgpt' }),
    row('mine'),
  ])
  expect(h.consumer.routingRows()).toHaveLength(1)
  const custody = new ClaustrumScopedCustody({
    client: h.client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    family: {
      ...classifyingFamily(facts('pi')),
      classify: () => ({ kind: 'refused', code: 'server-secret' as never }),
    },
  })
  try {
    const inventory = await custody.discover()
    expect(inventory.refused).toEqual([
      { credentialId: 'refused', code: 'unclassified' },
      { credentialId: 'not-mine', code: 'unclassified' },
      { credentialId: 'mine', code: 'unclassified' },
    ])
  } finally {
    custody.close()
  }
})
