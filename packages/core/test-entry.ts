// Test fixtures belong here, outside the source tree bundled into host packages.
export * from './src/index.ts'

import type { ProviderEntry } from './src/providers.ts'
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
export const catalogEntries: readonly ProviderEntry[] = [
  ...[
    'cerebras',
    'cline-pass',
    'deepseek',
    'inception',
    'openrouter',
    'typesafe',
    'meta',
    'opencode-go',
  ].map(
    (id): ProviderEntry => ({
      service: id,
      ids: [id],
      hosts: {
        opencode1: id,
        opencode2: id,
        ...(!['cline-pass', 'inception', 'typesafe'].includes(id)
          ? { pi: id }
          : {}),
      },
      class: 'A',
      origins: ['https://catalog.invalid'],
    }),
  ),
  {
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
    service: 'xai',
    ids: ['xai'],
    hosts: { opencode1: 'xai', pi: 'xai' },
    class: 'A',
    origins: ['https://api.x.ai'],
  },
  {
    service: 'opencode-zen',
    ids: ['opencode'],
    hosts: { opencode1: 'opencode', pi: 'opencode' },
    class: 'A',
    origins: ['https://opencode.ai'],
  },
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
