import {
  type HostFacts,
  type ProviderEntry,
  pluginId,
} from '@cortexkit/claustrum-auth-core'
import type {
  ClaustrumConsumer,
  ClaustrumDiscoveryHub,
} from '@cortexkit/common-auth/claustrum'
import {
  installOpenCode2Auth,
  type OpenCode2AuthInstallation,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import { createVaultAdapter, markUntil, type VaultAttempt } from './adapter.ts'
import {
  noAccountText,
  placementText,
  unreachableText,
  vaultOffText,
} from './messages.ts'

/** The login method id every served provider gets on OpenCode 2. */
export const vaultMethodId = 'claustrum-auth'
export const vaultMethodLabel = 'Claustrum vault (claustrum-auth plugin)'

/** What the entry builds once the host's catalog is known. */
export interface ServerCore {
  hub: Pick<ClaustrumDiscoveryHub, 'start' | 'refresh' | 'dispose'>
  consumers: ReadonlyMap<string, ClaustrumConsumer>
  entries: readonly ProviderEntry[]
}

export interface ServerDeps {
  /** Builds the hub and its members for the providers this host knows. */
  createCore(facts: HostFacts): ServerCore
  /** This host's account mode, read fresh from the enrollment files. */
  authority(): Promise<'vault' | 'local' | 'unreadable'>
  now?: () => number
  /** Errors that never reach the host: discovery, 401 reports. */
  onError?: (error: unknown) => void
  /** Test seam: sees every installation the entry makes. */
  observe?: (
    provider: string,
    installation: OpenCode2AuthInstallation<never, VaultAttempt>,
  ) => void
}

export type SetupContext = Pick<
  Plugin.Context,
  'session' | 'event' | 'integration' | 'provider'
>

/**
 * Records which providers the host's catalog holds and under which
 * integration, through the provider transform, without changing anything.
 * Reading the catalog once makes the host run every registered transform,
 * this one included.
 */
async function hostFacts(ctx: SetupContext) {
  const seen = new Map<string, string>()
  const registration = await ctx.provider.transform((editor) => {
    seen.clear()
    for (const record of editor.list())
      seen.set(
        record.provider.id,
        record.provider.integrationID ?? record.provider.id,
      )
  })
  await ctx.provider.list()
  const facts: HostFacts = {
    host: 'opencode2',
    catalog: [...seen.keys()].sort(),
    integrations: Object.fromEntries(seen),
  }
  return { facts, registration }
}

/**
 * Sets the OpenCode 2 entry up: at start, every supported provider the host's
 * catalog knows gets the vault login method and a gated installation, whether
 * or not the vault answers now, so the user can activate it once the vault
 * is reachable without a restart.
 */
export async function setupServer(ctx: SetupContext, deps: ServerDeps) {
  const now = deps.now ?? Date.now
  const { facts, registration: catalog } = await hostFacts(ctx)
  const core = deps.createCore(facts)
  const disposers: (() => Promise<void>)[] = []
  const cleanup = async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose()
      } catch (error) {
        deps.onError?.(error)
      }
    }
  }
  disposers.push(() => core.hub.dispose())
  disposers.push(() => catalog.dispose())
  try {
    for (const entry of core.entries) {
      const provider = entry.hosts.opencode2
      const consumer = provider ? core.consumers.get(provider) : undefined
      if (!provider || !consumer) continue
      const marks = new Map<string, number>()
      const methods = await registerOpenCode2AuthMethods(ctx, {
        integrationID: provider,
        methods: [],
        onLogin: () => {},
        label: vaultMethodLabel,
        now,
        vault: {
          method: { id: vaultMethodId, type: 'oauth', label: vaultMethodLabel },
          instructions:
            'No browser sign-in: the claustrum-auth plugin serves this provider from the Claustrum vault.',
          activate: () => activate(provider, consumer),
        },
      })
      disposers.push(() => methods.dispose())
      const installation = await installOpenCode2Auth<never, VaultAttempt>(
        ctx,
        createVaultAdapter({
          entry,
          provider,
          consumer,
          rateLimitMarks: marks,
          now,
          onError: deps.onError,
        }),
        {
          gateOnPlaceholder: {
            credential(headers) {
              const value = headers.get('authorization')
              return value?.startsWith('Bearer ')
                ? value.slice('Bearer '.length)
                : undefined
            },
            refuseMisplaced: (header) => placementText(provider, header),
          },
        },
      )
      disposers.push(() => installation.dispose())
      installation.on('limit', (event) => {
        marks.set(event.accountId, markUntil(event.limit, now()))
      })
      deps.observe?.(provider, installation)
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  core.hub.start()
  void core.hub.refresh().catch((error) => deps.onError?.(error))

  // OpenCode 2 activation: the host's login picker calls this, and only on
  // success stores the placeholder that makes later requests the plugin's.
  async function activate(provider: string, consumer: ClaustrumConsumer) {
    // A refusal stores nothing in the host; the message names the fix.
    if ((await deps.authority()) !== 'vault')
      throw new Error(vaultOffText(provider))
    try {
      await core.hub.refresh()
    } catch (error) {
      deps.onError?.(error)
      throw new Error(unreachableText(provider))
    }
    if (consumer.routingRows().length === 0)
      throw new Error(noAccountText(provider))
  }

  return async () => {
    await cleanup()
  }
}

/** The OpenCode 2 plugin object for a given set of dependencies. */
export function createServerPlugin(deps: () => ServerDeps) {
  return {
    id: pluginId,
    setup: (ctx: Plugin.Context) => setupServer(ctx, deps()),
  }
}
