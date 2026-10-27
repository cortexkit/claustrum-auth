// The shipped supported-provider table on the OpenCode 2 entry: a vault row
// for a live provider is served by that provider's own login method and its
// key goes only to the provider's documented origin.
import { expect, test } from 'bun:test'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { vaultRowFor } from '../../../core/test/fakes.ts'
import {
  type ProviderEntry,
  supportedProviders,
} from '../../../core/test-entry.ts'
import { vaultMethodId } from '../../src/v2/setup.ts'
import { type FakeHost, row, scope, startServer, trigger } from './fakes.ts'

const bearer = (provider: string) => ({
  authorization: `Bearer ${placeholderSecret(provider)}`,
})

async function login(host: FakeHost, provider: string) {
  const method = host.methods.get(`${provider}:${vaultMethodId}`)
  if (!method) throw new Error(`no vault method for ${provider}`)
  const pending = await method.authorize({})
  return pending.callback
}

async function send(host: FakeHost, provider: string, request: Request) {
  return trigger(host, 'http.request', { ...scope(provider), request })
}

// The catalog records a host reports for a table: one provider per entry it
// lists on OpenCode 2.
function opencode2Catalog(entries: readonly ProviderEntry[]) {
  return entries.flatMap((entry) => {
    const id = entry.hosts.opencode2
    return id ? [{ id }] : []
  })
}

test('the published entry registers the shipped providers, and no fixture provider', async () => {
  const { host } = await startServer({
    rows: [row('apikey:cerebras', { providerIds: ['cerebras'] })],
    catalog: opencode2Catalog(supportedProviders),
    table: supportedProviders,
  })
  const expected = supportedProviders.flatMap((entry) =>
    entry.hosts.opencode2 ? [entry.hosts.opencode2] : [],
  )
  expect([...host.methods.keys()].sort()).toEqual(
    expected.map((id) => `${id}:${vaultMethodId}`).sort(),
  )
  expect([
    ...new Set(
      (host.hooks.get('http.request') ?? []).map((hook) => hook.providerID),
    ),
  ]).toEqual(expected)
  expect(expected.some((id) => id.startsWith('fixture-'))).toBe(false)
})

test('opencode-zen gets no login method on OpenCode 2 even when the host knows it; xai does', async () => {
  // OpenCode 2's Console plugin reads the stored `opencode` credential
  // outside the request hooks, so OpenCode Zen is not served here although
  // the vault holds its row. xAI is served, over HTTP and over its WebSocket
  // handshake.
  const xai = supportedProviders.find((entry) => entry.service === 'xai')
  const zen = supportedProviders.find(
    (entry) => entry.service === 'opencode-zen',
  )
  if (!xai || !zen) throw new Error('missing batch 2 entries')
  const { host } = await startServer({
    rows: [vaultRowFor(xai), vaultRowFor(zen)],
    catalog: [...opencode2Catalog(supportedProviders), { id: 'opencode' }],
    table: supportedProviders,
  })
  expect(host.methods.has(`opencode:${vaultMethodId}`)).toBe(false)
  expect(
    (host.hooks.get('http.request') ?? []).map((hook) => hook.providerID),
  ).not.toContain('opencode')
  // Meta, OpenCode Go and xAI do register login methods on OpenCode 2.
  for (const id of ['meta', 'opencode-go', 'xai'])
    expect(host.methods.has(`${id}:${vaultMethodId}`)).toBe(true)
})

test('xai is served into its WebSocket handshake to wss://api.x.ai only, and a lookalike handshake origin is refused before the read', async () => {
  const xai = supportedProviders.find((entry) => entry.service === 'xai')
  if (!xai) throw new Error('missing xai entry')
  const vaultRow = vaultRowFor(xai)
  const { host, vault } = await startServer({
    rows: [vaultRow],
    catalog: opencode2Catalog(supportedProviders),
    table: supportedProviders,
  })
  await login(host, 'xai')
  const handshake = (url: string) =>
    trigger(host, 'experimental.ws.handshake', {
      ...scope('xai'),
      url,
      headers: { ...bearer('xai') },
    })
  const served = await handshake('wss://api.x.ai/v1/responses')
  expect(served.headers.authorization).toBe(`Bearer secret-${vaultRow.id}-1`)
  expect(vault.reads).toEqual([vaultRow.id])
  for (const lookalike of [
    'wss://api.x.ai.example/v1/responses',
    'wss://api.x.ai:8443/v1/responses',
    'ws://api.x.ai/v1/responses',
    'https://api.x.ai/v1/responses',
  ])
    await expect(handshake(lookalike)).rejects.toThrow(
      'is only sent over WebSocket to wss://api.x.ai',
    )
  expect(vault.reads).toEqual([vaultRow.id])
})

// One test per provider: each starts a server that writes owner-only files,
// and a single loop over every provider ran past Bun's 5 s default on
// Windows. A failure now also names the provider that broke.
test.each(
  supportedProviders
    .filter((entry) => entry.hosts.opencode2)
    .map((entry) => [entry.hosts.opencode2 as string, entry] as const),
)(
  '%s is served with its vault key, and a lookalike origin is refused before the read',
  async (provider, entry) => {
    {
      const origin = new URL(entry.origins[0] as string)
      // The operator's row: the fleet id (cline-pass: its exact credential id
      // and no provider id), which the plugin maps to OpenCode's id.
      const vaultRow = vaultRowFor(entry, {
        accountId: `account-${entry.service}`,
      })
      const credential = vaultRow.id
      const { host, vault } = await startServer({
        rows: [vaultRow],
        catalog: opencode2Catalog(supportedProviders),
        table: supportedProviders,
      })
      expect(await login(host, provider)).toMatchObject({
        type: 'oauth',
        access: placeholderSecret(provider),
      })
      const request = new Request(new URL('/v1/chat/completions', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(provider) },
        body: '{}',
      })
      const sent = await send(host, provider, request)
      expect([provider, sent.request.headers.get('authorization')]).toEqual([
        provider,
        `Bearer secret-${credential}-1`,
      ])
      expect(vault.reads).toEqual([credential])
      for (const lookalike of [
        `${origin.protocol}//${origin.hostname}.example`,
        `${origin.protocol}//${origin.hostname}:8443`,
        `http://${origin.hostname}`,
      ]) {
        await expect(
          send(
            host,
            provider,
            new Request(new URL('/v1/chat/completions', lookalike), {
              method: 'POST',
              headers: bearer(provider),
              body: '{}',
            }),
          ),
        ).rejects.toThrow('is only sent to')
      }
      expect(vault.reads).toEqual([credential])
    }
  },
)

test('a provider the host catalog does not hold gets no login method account', async () => {
  const { host } = await startServer({
    rows: [row('apikey:openrouter', { providerIds: ['openrouter'] })],
    catalog: [{ id: 'cerebras' }, { id: 'deepseek' }],
  })
  // The catalog holds cerebras and deepseek only, so neither a login method
  // nor a gated installation exists for openrouter, and activation refuses.
  expect(host.methods.has(`openrouter:${vaultMethodId}`)).toBe(false)
  expect(
    (host.hooks.get('http.request') ?? []).map((hook) => hook.providerID),
  ).not.toContain('openrouter')
})
