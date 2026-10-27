import {
  command,
  type HostFacts,
  type MenuConsumer,
  type MenuHub,
  type ProviderEntry,
  pluginId,
  reservedProviders,
  type ServingConsumer,
  vaultMenuText,
} from '@cortexkit/claustrum-auth-core'
import type { ClaustrumDiscoveryHub } from '@cortexkit/common-auth/claustrum'
import {
  installOpenCode2Auth,
  type OpenCode2AuthInstallation,
  placeholderSecret,
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
  hub: Pick<ClaustrumDiscoveryHub, 'start' | 'refresh' | 'dispose'> & MenuHub
  consumers: ReadonlyMap<string, ServingConsumer & MenuConsumer>
  entries: readonly ProviderEntry[]
}

export interface ServerDeps {
  /** The supported-provider table this build serves from. */
  table: readonly ProviderEntry[]
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
  'session' | 'event' | 'integration' | 'provider' | 'command'
>

/**
 * Which of `ids` the host's catalog holds, and under which integration. The
 * host's provider lookup reads the whole catalog, inactive providers
 * included, after every plugin's and the configuration's transforms.
 */
async function catalogFacts(
  ctx: SetupContext,
  ids: readonly string[],
): Promise<HostFacts> {
  const integrations: Record<string, string> = {}
  for (const id of ids) {
    let info: { id?: string; integrationID?: string } | undefined
    try {
      const found = (await ctx.provider.get({ providerID: id })) as unknown as {
        data?: typeof info
      } & typeof info
      info = found?.data ?? found
    } catch {
      continue
    }
    if (info?.id === id) integrations[id] = info.integrationID ?? id
  }
  return {
    host: 'opencode2',
    catalog: Object.keys(integrations).sort(),
    integrations,
  }
}

/**
 * Sets the OpenCode 2 entry up. At start, every supported provider of the
 * table gets the vault login method and a gated installation, whether or not
 * the vault answers now, so the user can activate it once the vault is
 * reachable without a restart.
 *
 * The hub is built on first use (an activation or an owned request), not at
 * start: the host sets plugins up before it has applied the configuration's
 * providers, and the hub's members and classification depend on which
 * providers the catalog holds.
 */
export async function setupServer(ctx: SetupContext, deps: ServerDeps) {
  const now = deps.now ?? Date.now
  let closed = false
  const disposers: (() => Promise<void>)[] = []
  const cleanup = async () => {
    closed = true
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose()
      } catch (error) {
        deps.onError?.(error)
      }
    }
  }
  const entries = deps.table.filter((entry) => {
    const id = entry.hosts.opencode2
    return id !== undefined && !reservedProviders.some((r) => r === id)
  })
  const ids = entries.map((entry) => entry.hosts.opencode2 as string)
  const latestRefusal = new Map<string, string>()

  let core: Promise<ServerCore> | undefined
  const ready = () => {
    core ??= (async () => {
      const built = deps.createCore(await catalogFacts(ctx, ids))
      if (closed) {
        // Disposed while the catalog was read: nothing may keep running.
        await built.hub.dispose()
        throw new Error('claustrum-auth plugin: stopped.')
      }
      disposers.push(() => built.hub.dispose())
      built.hub.start()
      try {
        await built.hub.refresh()
      } catch (error) {
        deps.onError?.(error)
      }
      return built
    })()
    return core
  }
  const consumerOf = async (provider: string) =>
    (await ready()).consumers.get(provider)

  // OpenCode 2 activation: the host's login picker calls this, and only on
  // success stores the placeholder that makes later requests the plugin's.
  // A refusal stores nothing in the host; the message names the fix.
  async function activate(provider: string) {
    if ((await deps.authority()) !== 'vault')
      throw new Error(vaultOffText(provider))
    const built = await ready()
    try {
      await built.hub.refresh()
    } catch (error) {
      deps.onError?.(error)
      throw new Error(unreachableText(provider))
    }
    const consumer = built.consumers.get(provider)
    if (!consumer || consumer.routingRows().length === 0)
      throw new Error(noAccountText(provider))
  }

  try {
    const registration = await ctx.command.transform((editor) => {
      editor.add({
        name: command.slice(1),
        description:
          'claustrum-auth plugin: status, accounts, refusals and reorder',
        execute: async (input) => {
          const built = await ready()
          const text = await vaultMenuText(
            {
              authority: deps.authority,
              hub: built.hub,
              consumers: built.consumers,
              latestRefusal,
              providerStatus: async (provider) => {
                const active = await ctx.integration.connection.active(provider)
                const value =
                  active?.type === 'credential'
                    ? await ctx.integration.connection.resolve(active)
                    : undefined
                return value?.type === 'oauth' &&
                  value.access === placeholderSecret(provider)
                  ? 'owned'
                  : 'available (select the vault login to activate)'
              },
            },
            input.prompt.text.trim().replace(/^\/claustrum(?:\s+|$)/u, ''),
          )
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text,
            delivery: input.delivery,
            resume: false,
          })
        },
      })
    })
    disposers.push(() => registration.dispose())
    for (const entry of entries) {
      const provider = entry.hosts.opencode2 as string
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
          activate: () => activate(provider),
        },
      })
      disposers.push(() => methods.dispose())
      const installation = await installOpenCode2Auth<never, VaultAttempt>(
        ctx,
        createVaultAdapter({
          entry,
          provider,
          consumer: () => consumerOf(provider),
          rateLimitMarks: marks,
          now,
          onError: deps.onError,
          onRefusal: (code) => latestRefusal.set(provider, code),
        }),
        {
          gateOnPlaceholder: {
            credential(headers) {
              const value = headers.get('authorization')
              return value?.startsWith('Bearer ')
                ? value.slice('Bearer '.length)
                : undefined
            },
            refuseMisplaced: (header) => {
              latestRefusal.set(provider, 'placement-refused')
              return placementText(provider, header)
            },
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
