// The published supported-provider table (design section 5.4) against fakes:
// which vault row becomes which provider's account on each host, where an
// owned request may send the key, and that the published build lists the live
// providers while the fixtures stay out of it.
import { expect, test } from 'bun:test'
import {
  classifyRow,
  createFetch,
  type Host,
  type RefusalCode,
  servingCallbacks,
} from '../src/index.ts'
import {
  catalogFor,
  fixtureEntries,
  liveFacts,
  publishedFacts,
  supportedProviders,
  tableByService,
} from '../test-entry.ts'
import { bearer, liveHarness, placeholder, row } from './fakes.ts'

type Outcome =
  | { kind: 'mine'; member: string }
  | { kind: 'refused'; code: RefusalCode }

// The vault rows the operator holds, as the vault lists them: credential ids,
// fleet provider ids, credential type and categories. Classification routes on
// this metadata only; the one exception is cline-pass, matched by its exact
// credential id because its row deliberately carries no provider id.
const vaultRows: {
  credential: string
  providerIds: readonly string[]
  credentialType?: 'oauth' | 'api_key'
  categories?: readonly string[]
  expected: (host: Host) => Outcome
}[] = [
  {
    credential: 'apikey:cerebras',
    providerIds: ['cerebras'],
    expected: () => ({ kind: 'mine', member: 'cerebras' }),
  },
  {
    credential: 'apikey:deepseek',
    providerIds: ['deepseek'],
    expected: () => ({ kind: 'mine', member: 'deepseek' }),
  },
  {
    // The fleet id `fireworks-ai` is OpenCode's id too; Pi serves it as its
    // own `fireworks`.
    credential: 'apikey:fireworks-ai',
    providerIds: ['fireworks-ai'],
    expected: (host) => ({
      kind: 'mine',
      member: host === 'pi' ? 'fireworks' : 'fireworks-ai',
    }),
  },
  {
    credential: 'apikey:inception',
    providerIds: ['inception'],
    expected: (host) =>
      host === 'pi'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'inception' },
  },
  {
    credential: 'apikey:openrouter',
    providerIds: ['openrouter'],
    expected: () => ({ kind: 'mine', member: 'openrouter' }),
  },
  {
    // The fleet id names Kimi's coding plan; each host has its own id for it.
    credential: 'apikey:kimi-for-coding',
    providerIds: ['kimi-code-plan-global'],
    expected: (host) => ({
      kind: 'mine',
      member: host === 'pi' ? 'kimi-coding' : 'kimi-for-coding',
    }),
  },
  {
    credential: 'apikey:typesafe',
    providerIds: ['typesafe'],
    expected: (host) =>
      host === 'pi'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'typesafe' },
  },
  {
    // No provider id on purpose, so fleet routing never picks it.
    credential: 'apikey:cline-pass',
    providerIds: [],
    expected: (host) =>
      host === 'pi'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'cline-pass' },
  },
  {
    // `meta-native` marks a row a dedicated plugin may own later; no such
    // plugin exists, and the reserved matrix does not name `meta`.
    credential: 'oauth:meta',
    providerIds: ['meta'],
    credentialType: 'oauth',
    categories: ['llm-provider', 'meta-native'],
    expected: () => ({ kind: 'mine', member: 'meta' }),
  },
  {
    credential: 'oauth:xai',
    providerIds: ['xai'],
    credentialType: 'oauth',
    categories: ['llm-provider', 'xai-native'],
    expected: (host) =>
      host === 'opencode2'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'xai' },
  },
  {
    credential: 'apikey:opencode-go',
    providerIds: ['opencode-go'],
    expected: () => ({ kind: 'mine', member: 'opencode-go' }),
  },
  {
    credential: 'apikey:opencode-zen',
    providerIds: ['opencode'],
    expected: (host) =>
      host === 'opencode2'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'opencode' },
  },
]

const hosts: Host[] = ['opencode1', 'opencode2', 'pi']

function facts(item: (typeof vaultRows)[number]) {
  return {
    credentialId: item.credential,
    credentialType: item.credentialType ?? 'api_key',
    authMethod: item.credentialType === 'oauth' ? 'oauth' : 'api-key',
    categories: item.categories ?? ['llm-provider'],
    providerIds: item.providerIds,
  }
}

test('every live entry maps its fleet ids to a host id on each host it lists', () => {
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
  for (const entry of supportedProviders) {
    expect(entry.class).toBe('A')
    expect(entry.ids.length).toBeGreaterThan(0)
    for (const origin of entry.origins)
      expect(new URL(origin).protocol).toBe('https:')
  }
  const hostIds = (host: Host) =>
    Object.fromEntries(
      supportedProviders.flatMap((entry) =>
        entry.hosts[host] ? [[entry.service, entry.hosts[host]]] : [],
      ),
    )
  expect(hostIds('opencode1')).toEqual({
    cerebras: 'cerebras',
    'cline-pass': 'cline-pass',
    deepseek: 'deepseek',
    fireworks: 'fireworks-ai',
    inception: 'inception',
    'kimi-coding': 'kimi-for-coding',
    openrouter: 'openrouter',
    typesafe: 'typesafe',
    meta: 'meta',
    xai: 'xai',
    'opencode-go': 'opencode-go',
    'opencode-zen': 'opencode',
  })
  // xAI waits for its WebSocket handshake proof, and OpenCode Zen's stored
  // credential is read by the host's Console plugin outside the request hooks.
  const { xai: _xai, 'opencode-zen': _zen, ...opencode2 } = hostIds('opencode1')
  expect(hostIds('opencode2')).toEqual(opencode2)
  // Pi registers a provider only through pi-ai's bearer apis, so the services
  // Pi's own catalog does not offer as bearer providers are OpenCode only.
  expect(hostIds('pi')).toEqual({
    cerebras: 'cerebras',
    deepseek: 'deepseek',
    fireworks: 'fireworks',
    'kimi-coding': 'kimi-coding',
    openrouter: 'openrouter',
    meta: 'meta',
    xai: 'xai',
    'opencode-go': 'opencode-go',
    'opencode-zen': 'opencode',
  })
})

test('each shipped origin is the provider API host, and no other host of it is allowed', () => {
  const shipped: Record<string, readonly string[]> = Object.fromEntries(
    supportedProviders.map((entry) => [entry.service, entry.origins]),
  )
  expect(shipped).toEqual({
    cerebras: ['https://api.cerebras.ai'],
    'cline-pass': ['https://api.cline.bot'],
    deepseek: ['https://api.deepseek.com'],
    fireworks: ['https://api.fireworks.ai'],
    inception: ['https://api.inceptionlabs.ai'],
    'kimi-coding': ['https://api.kimi.com'],
    openrouter: ['https://openrouter.ai'],
    typesafe: ['https://api.typesafe.ai'],
    meta: ['https://api.meta.ai'],
    xai: ['https://api.x.ai'],
    'opencode-go': ['https://opencode.ai'],
    'opencode-zen': ['https://opencode.ai'],
  })
})

test('the operator vault rows route to their provider on every host, and nowhere else', () => {
  for (const host of hosts) {
    const hostFacts = liveFacts(host)
    for (const item of vaultRows) {
      expect([
        item.credential,
        host,
        classifyRow(facts(item), hostFacts),
      ]).toEqual([item.credential, host, item.expected(host)])
    }
  }
})

test('cline-pass is served by its exact credential id only while the row has no provider id', () => {
  const cline = vaultRows.find(
    (item) => item.credential === 'apikey:cline-pass',
  )
  if (!cline) throw new Error('no cline-pass row')
  for (const host of hosts) {
    const hostFacts = liveFacts(host)
    // Another credential with no provider id is not cline-pass, however
    // close its name: the match is exact, with no prefix or pattern.
    for (const credential of [
      'apikey:cline-pass-2',
      'apikey:cline',
      'APIKEY:CLINE-PASS',
      'apikey:cline-pass ',
    ])
      expect(
        classifyRow({ ...facts(cline), credentialId: credential }, hostFacts),
      ).toEqual({
        kind: 'refused',
        code: 'unmapped',
      })
    // Once the row names a provider, the credential id plays no part: the
    // row is classified by its ids like any other.
    expect(
      classifyRow({ ...facts(cline), providerIds: ['deepseek'] }, hostFacts),
    ).toEqual({ kind: 'mine', member: 'deepseek' })
    expect(
      classifyRow(
        { ...facts(cline), providerIds: ['a-fleet-id-the-table-lacks'] },
        hostFacts,
      ),
    ).toEqual({ kind: 'refused', code: 'unsupported-provider' })
  }
})

test('fleet ids map to each host id: fireworks-ai on Pi is fireworks, kimi-code-plan-global is kimi on both hosts', () => {
  const row = (providerIds: string[]) => ({
    credentialId: 'opaque',
    credentialType: 'api_key',
    authMethod: 'api-key',
    categories: ['llm-provider'],
    providerIds,
  })
  for (const host of hosts) {
    const facts = liveFacts(host)
    expect(classifyRow(row(['fireworks-ai']), facts)).toEqual({
      kind: 'mine',
      member: host === 'pi' ? 'fireworks' : 'fireworks-ai',
    })
    expect(classifyRow(row(['kimi-code-plan-global']), facts)).toEqual({
      kind: 'mine',
      member: host === 'pi' ? 'kimi-coding' : 'kimi-for-coding',
    })
    // A fleet id the table has no mapping for is refused, never guessed.
    expect(classifyRow(row(['kimi-code-plan-cn']), facts)).toEqual({
      kind: 'refused',
      code: 'unsupported-provider',
    })
    // A host id beside the fleet id is not a fleet id, so the row is refused
    // as naming two things rather than served under either.
    expect(classifyRow(row(['fireworks-ai', 'fireworks']), facts)).toEqual({
      kind: 'refused',
      code: 'mixed-services',
    })
  }
})

test('a row naming this batch beside another service is refused rather than guessing', () => {
  const facts = liveFacts('opencode2')
  expect(
    classifyRow(
      {
        credentialId: 'opaque',
        credentialType: 'api_key',
        authMethod: 'api-key',
        categories: ['llm-provider'],
        providerIds: ['deepseek', 'openrouter'],
      },
      facts,
    ),
  ).toEqual({ kind: 'refused', code: 'mixed-services' })
  expect(
    classifyRow(
      {
        credentialId: 'opaque',
        credentialType: 'api_key',
        authMethod: 'api-key',
        categories: ['llm-provider'],
        providerIds: ['deepseek', 'google'],
      },
      facts,
    ),
  ).toEqual({ kind: 'refused', code: 'reserved-provider' })
})

test('a live provider is refused on a host whose catalog no longer knows it', () => {
  expect(
    classifyRow(
      {
        credentialId: 'apikey:openrouter',
        credentialType: 'api_key',
        authMethod: 'api-key',
        categories: ['llm-provider'],
        providerIds: ['openrouter'],
      },
      publishedFacts('opencode2', ['deepseek']),
    ),
  ).toEqual({ kind: 'refused', code: 'unknown-to-host' })
})

test('the catalog a test host is given holds both the live and the fixture providers', () => {
  for (const host of hosts) {
    const catalog = catalogFor(host)
    for (const entry of supportedProviders) {
      const id = entry.hosts[host]
      if (id) expect(catalog).toContain(id)
    }
    for (const entry of fixtureEntries) {
      const id = entry.hosts[host]
      if (id) expect(catalog).toContain(id)
    }
  }
  expect(tableByService.get('fireworks')?.origins).toEqual([
    'https://api.fireworks.ai',
  ])
})

test('a shipped provider serves its vault row only to its documented origin', async () => {
  const rows = (host: Host) =>
    vaultRows.flatMap((item) =>
      item.expected(host).kind === 'mine'
        ? [
            row(item.credential, {
              providerIds: item.providerIds,
              credentialType: item.credentialType ?? 'api_key',
              categories: [...(item.categories ?? ['llm-provider'])],
              accountId: `account-${item.credential}`,
            }),
          ]
        : [],
    )
  for (const host of hosts) {
    const h = await liveHarness(rows(host), host)
    for (const item of vaultRows) {
      const outcome = item.expected(host)
      if (outcome.kind !== 'mine') continue
      const entry = supportedProviders.find(
        (candidate) => candidate.hosts[host] === outcome.member,
      )
      if (!entry) throw new Error(`no entry for ${outcome.member}`)
      const consumer = h.consumers.get(outcome.member)
      if (!consumer) throw new Error(`no ${outcome.member} member on ${host}`)
      // The provider's own origin is served with the row's key.
      let reached = ''
      const fetch = createFetch({
        entry,
        placeholder,
        consumer,
        fetch: async (input) => {
          reached = (input as Request).headers.get('authorization') ?? ''
          return new Response('ok')
        },
      })
      const allowed = new URL(entry.origins[0] as string)
      expect(
        await (
          await fetch(new URL('/v1/chat/completions', allowed).href, {
            headers: bearer,
          })
        ).text(),
      ).toBe('ok')
      expect(reached).toBe(`Bearer ${h.secretOf(item.credential)}`)
      // A lookalike host, or the provider's API host on another port or scheme,
      // is refused before the vault is read and never sees a request.
      const reads = h.reads.length
      for (const lookalike of [
        `${allowed.protocol}//${allowed.hostname}.example`,
        `${allowed.protocol}//${allowed.hostname}:8443`,
        `https://${allowed.hostname.split('.').slice(1).join('.')}`,
      ]) {
        await expect(
          fetch(new URL('/v1/chat/completions', lookalike).href, {
            headers: bearer,
          }),
        ).rejects.toMatchObject({ code: 'origin-refused' })
      }
      expect(h.reads).toHaveLength(reads)
      expect(reached).toBe(`Bearer ${h.secretOf(item.credential)}`)
    }
  }
})

test('a shipped provider refuses a misplaced placeholder with no vault read', async () => {
  const h = await liveHarness(
    [row('apikey:deepseek', { providerIds: ['deepseek'] })],
    'opencode2',
  )
  const consumer = h.consumers.get('deepseek')
  const entry = tableByService.get('deepseek')
  if (!consumer || !entry) throw new Error('missing deepseek member')
  const options = { entry, placeholder, consumer }
  const fetch = createFetch({
    ...options,
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  for (const headers of [
    { 'x-api-key': placeholder },
    { ...bearer, 'x-api-key': placeholder },
    { authorization: placeholder },
  ] as Record<string, string>[]) {
    await expect(
      fetch('https://api.deepseek.com/v1/chat/completions', { headers }),
    ).rejects.toMatchObject({ code: 'placement-refused' })
    await expect(
      servingCallbacks(options).request(
        new URL('https://api.deepseek.com/v1/chat/completions'),
        new Headers(headers),
      ),
    ).rejects.toMatchObject({ code: 'placement-refused' })
  }
  expect(h.reads).toEqual([])
})
