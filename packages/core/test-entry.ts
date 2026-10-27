// Test fixtures belong here, outside the source tree bundled into host packages.
export * from './src/index.ts'

import type { Host, HostFacts, ProviderEntry } from './src/providers.ts'
import { supportedProviders } from './src/providers.ts'
import type { CoreOptions } from './src/runtime.ts'
import { createCoreWithTable } from './src/runtime.ts'

export const fixtureEntries: readonly ProviderEntry[] = [
  {
    service: 'fixture-a',
    ids: ['fixture-a'],
    hosts: { opencode1: 'fixture-a', opencode2: 'fixture-a', pi: 'fixture-a' },
    class: 'A',
    origins: [
      'https://fixture.invalid',
      'wss://fixture.invalid',
      'http://127.0.0.1:8123',
    ],
  },
  {
    service: 'fixture-b',
    ids: ['fixture-b'],
    hosts: { opencode1: 'fixture-b', opencode2: 'fixture-b', pi: 'fixture-b' },
    class: 'B',
    origins: ['https://fixture.invalid'],
    accountPath: ['client', 'v4', 'accounts'],
  },
  {
    service: 'fixture-c',
    ids: ['fixture-c'],
    hosts: { opencode1: 'fixture-c', opencode2: 'fixture-c', pi: 'fixture-c' },
    class: 'C',
    origins: ['https://fixture.invalid'],
  },
]

// Catalog simulations do not enable providers. Real entries must verify bearer
// placement, origins, redirects and redaction on each host before publication.
// This is the shipped table plus the services that have no live entry yet.
export const catalogEntries: readonly ProviderEntry[] = [
  ...supportedProviders,
  {
    service: 'cloudflare-workers-ai',
    ids: ['cloudflare-workers-ai'],
    hosts: {
      opencode1: 'cloudflare-workers-ai',
      opencode2: 'cloudflare-workers-ai',
      pi: 'cloudflare-workers-ai',
    },
    class: 'B',
    origins: ['https://api.cloudflare.com'],
    accountPath: ['client', 'v4', 'accounts'],
  },
]

export function createTestCore(options: CoreOptions, table = fixtureEntries) {
  return createCoreWithTable(options, table)
}

// A real host's catalog carries the live providers and the fixture providers
// the harness adds. Tests that exercise the shipped table place rows against
// this catalog instead of a hand-written list of ids.
export function catalogFor(host: Host): string[] {
  return [...supportedProviders, ...fixtureEntries].flatMap((entry) => {
    const id = entry.hosts[host]
    return id ? [id] : []
  })
}

// Facts as a host that knows every live provider would report them: its own
// catalog and, on OpenCode 2, one integration per provider id.
export function publishedFacts(
  host: Host,
  catalog: readonly string[] = supportedProviders.flatMap((entry) => {
    const id = entry.hosts[host]
    return id ? [id] : []
  }),
): HostFacts {
  return {
    host,
    catalog,
    ...(host === 'opencode2'
      ? { integrations: Object.fromEntries(catalog.map((id) => [id, id])) }
      : {}),
  }
}

export function liveFacts(host: Host): HostFacts {
  const catalog = catalogFor(host)
  return {
    host,
    catalog,
    ...(host === 'opencode2'
      ? { integrations: Object.fromEntries(catalog.map((id) => [id, id])) }
      : {}),
  }
}

export const tableByService = new Map(
  supportedProviders.map((entry) => [entry.service, entry]),
)
