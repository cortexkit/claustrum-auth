// The Pi test build: the real extension with fixture providers, loopback
// origins and a fake vault reached over HTTP. It lives outside src, so neither the published bundle nor npm pack
// can contain it.
import { appendFileSync } from 'node:fs'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  createTestCore,
  type ProviderEntry,
  supportedProviders,
} from '../core/test-entry.ts'
import { createPiExtension } from './src/extension.ts'

export interface PiTestConfig {
  /** The mock provider's loopback origin, the only one fixtures may reach. */
  origin: string
  /** Base URL of the fake vault. */
  vault: string
  syncMs?: number
  /** A file that receives one line per provider registration. */
  registrations?: string
  /**
   * Serve the shipped supported-provider table instead of the fixtures, with
   * the mock's loopback origin added to each entry so a models.json override
   * can point a live provider at the mock. Every other origin stays refused.
   */
  shipped?: boolean
}

const config = JSON.parse(
  process.env.CLAUSTRUM_AUTH_PI_TEST ?? '{}',
) as PiTestConfig

const entry = (
  id: string,
  extra: Partial<ProviderEntry> = {},
): ProviderEntry => ({
  service: id,
  ids: [id],
  hosts: { opencode1: id, opencode2: id, pi: id },
  class: 'A',
  origins: [config.origin],
  ...extra,
})

export const piFixtureEntries: readonly ProviderEntry[] = [
  entry('fixture-a'),
  entry('fixture-b', {
    class: 'B',
    accountPath: ['client', 'v4', 'accounts'],
  }),
  entry('fixture-c', { class: 'C' }),
  entry('fixture-p'),
  ...Array.from({ length: 9 }, (_, index) => entry(`fixture-n${index + 1}`)),
]

// The shipped table as the test build serves it: ids, host mapping and the
// documented origins unchanged, plus the mock's origin standing in for the
// provider's API host.
const shippedEntries: readonly ProviderEntry[] = supportedProviders.map(
  (shipped) => ({ ...shipped, origins: [...shipped.origins, config.origin] }),
)

class VaultDown extends Error {
  readonly code = 'ECONNREFUSED'
}

async function call(op: string, body?: unknown) {
  let response: Response
  try {
    response = await fetch(`${config.vault}/${op}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    throw new VaultDown('fake vault offline')
  }
  if (response.status === 503) throw new VaultDown('fake vault offline')
  if (!response.ok) {
    const { code } = (await response.json()) as { code: string }
    throw Object.assign(new Error(`fake vault refused: ${code}`), { code })
  }
  return response.json()
}

const client: ClaustrumScopedClient = {
  listScoped: () => call('list'),
  getScoped: (input) => call('get', input),
  async reportAuthFailureScoped(input) {
    await call('report', input)
  },
  close() {},
}

const extension = createPiExtension({
  createCore: (options) =>
    createTestCore(options, config.shipped ? shippedEntries : piFixtureEntries),
  connect: async () => client,
  syncIntervalMs: config.syncMs ?? 200,
})

export default function claustrumAuthTest(pi: ExtensionAPI) {
  const log = config.registrations
  if (!log) return extension(pi)
  const registerProvider = (name: string, provider: never) => {
    appendFileSync(
      log,
      `${JSON.stringify({ name, models: (provider as { models?: unknown[] }).models?.length ?? null })}\n`,
    )
    return pi.registerProvider(name, provider)
  }
  const recorded = new Proxy(pi, {
    get(target, key) {
      if (key === 'registerProvider') return registerProvider
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return extension(recorded)
}
