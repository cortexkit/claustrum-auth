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
// provider ids and the `llm-provider` category. Classification routes on this
// metadata only and never reads the credential id.
const vaultRows: {
  credential: string
  providerIds: readonly string[]
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
    // The operator's row names OpenCode's id only, so Pi refuses it: no host
    // substitutes one of its own ids for another's (section 4.2 step 7).
    credential: 'apikey:fireworks-ai',
    providerIds: ['fireworks-ai'],
    expected: (host) =>
      host === 'pi'
        ? { kind: 'refused', code: 'host-id-missing' }
        : { kind: 'mine', member: 'fireworks-ai' },
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
    credential: 'apikey:kimi-for-coding',
    providerIds: ['kimi-code-plan-global'],
    expected: () => ({ kind: 'refused', code: 'unsupported-provider' }),
  },
  {
    credential: 'apikey:typesafe',
    providerIds: ['typesafe'],
    expected: (host) =>
      host === 'pi'
        ? { kind: 'refused', code: 'not-on-this-host' }
        : { kind: 'mine', member: 'typesafe' },
  },
]

const hosts: Host[] = ['opencode1', 'opencode2', 'pi']

test('every live entry serves its own host id and lists every host that sends Authorization', () => {
  expect(supportedProviders.map((entry) => entry.service)).toEqual([
    'cerebras',
    'cline-pass',
    'deepseek',
    'fireworks',
    'inception',
    'kimi-coding',
    'openrouter',
    'typesafe',
  ])
  for (const entry of supportedProviders) {
    expect(entry.class).toBe('A')
    for (const host of hosts) {
      const id = entry.hosts[host]
      if (!id) continue
      expect(entry.ids).toContain(id)
      for (const origin of entry.origins)
        expect(new URL(origin).protocol).toBe('https:')
    }
  }
  // Pi registers a provider only through pi-ai's bearer apis, so the services
  // Pi's own catalog does not offer as bearer providers are OpenCode only.
  const onPi = supportedProviders.flatMap((entry) => entry.hosts.pi ?? [])
  expect(onPi.sort()).toEqual([
    'cerebras',
    'deepseek',
    'fireworks',
    'kimi-coding',
    'openrouter',
  ])
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
  })
})

test('the operator vault rows route to their provider on every host, and nowhere else', () => {
  for (const host of hosts) {
    const facts = liveFacts(host)
    for (const item of vaultRows) {
      expect([
        item.credential,
        host,
        classifyRow(
          {
            credentialId: item.credential,
            credentialType: 'api_key',
            authMethod: 'api-key',
            categories: ['llm-provider'],
            providerIds: item.providerIds,
          },
          facts,
        ),
      ]).toEqual([item.credential, host, item.expected(host)])
    }
  }
})

test('a row naming both the OpenCode and the Pi id of one service is served on both hosts', () => {
  const row = (providerIds: string[]) => ({
    credentialId: 'opaque',
    credentialType: 'api_key',
    authMethod: 'api-key',
    categories: ['llm-provider'],
    providerIds,
  })
  for (const host of hosts) {
    const facts = liveFacts(host)
    expect(classifyRow(row(['fireworks-ai', 'fireworks']), facts)).toEqual({
      kind: 'mine',
      member: host === 'pi' ? 'fireworks' : 'fireworks-ai',
    })
    expect(classifyRow(row(['kimi-for-coding', 'kimi-coding']), facts)).toEqual(
      {
        kind: 'mine',
        member: host === 'pi' ? 'kimi-coding' : 'kimi-for-coding',
      },
    )
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
      const entry = tableByService.get(
        supportedProviders.find((candidate) =>
          candidate.ids.includes(outcome.member),
        )?.service as string,
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
