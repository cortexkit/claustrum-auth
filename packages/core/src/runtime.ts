import {
  type ClaustrumConsumer,
  ClaustrumDiscoveryHub,
  type ClaustrumDiscoveryHubOptions,
} from '@cortexkit/common-auth/claustrum'
import {
  classifyingFamily,
  type HostFacts,
  listedProviders,
  type ProviderEntry,
  reservedProviders,
  supportedProviders,
} from './providers.js'

export type CoreOptions = Pick<
  ClaustrumDiscoveryHubOptions,
  'stateDir' | 'tokenPath' | 'connect' | 'isCustodyActive' | 'now' | 'onError'
> & { facts: HostFacts }

export function createCore(options: CoreOptions) {
  return createCoreWithTable(options, supportedProviders)
}

// The public entry fixes the table. Only the unpublished test entry supplies
// fixture services; hosts cannot opt into loopback through configuration.
export function createCoreWithTable(
  options: CoreOptions,
  table: readonly ProviderEntry[],
) {
  const { facts, ...hubOptions } = options
  const entries = listedProviders(facts, table)
  const members = entries
    .map((entry) => entry.hosts[facts.host] as string)
    .sort()
  const hub = new ClaustrumDiscoveryHub({
    ...hubOptions,
    hostGeneration: facts.host,
    classifierInput: {
      // The classification rules, not the data: version 2 reads provider ids
      // as fleet ids and admits the exact-credential-id entries. A new version
      // keeps rosters projected under the old rules apart.
      version: 2,
      facts,
      table,
      reservedProviders,
      members,
    },
    members,
    family: classifyingFamily(facts, table),
  })
  // The latest failure each member reported, such as a roster commit that
  // could not write its file. `unsavedRosterCause` reads it to name why a
  // member holds no account list.
  const memberErrors = new Map<string, unknown>()
  const consumers = new Map(
    members.map((provider) => [
      provider,
      hub.member(provider, {
        onError: (error) => memberErrors.set(provider, error),
      }),
    ]),
  )
  return { hub, consumers, entries, memberErrors }
}

/** What `unsavedRosterCause` reads from a core built by `createCore`. */
export interface RosterCore {
  hub: Pick<ClaustrumDiscoveryHub, 'refresh'>
  consumers: ReadonlyMap<string, Pick<ClaustrumConsumer, 'snapshot'>>
  memberErrors: Map<string, unknown>
}

// A short, fixed name for why a member's account list was not saved: an
// error code such as EPERM, or a consumer error kind. A member whose roster
// lock was held past the wait reports no error at all.
function rosterFailureCause(error: unknown): string {
  if (error === undefined) return 'its file was locked'
  if (error && typeof error === 'object') {
    const { code, kind } = error as { code?: unknown; kind?: unknown }
    if (typeof code === 'string' && code) return code
    if (typeof kind === 'string' && kind) return kind
  }
  return error instanceof Error ? error.name : 'unknown error'
}

/**
 * Call after a hub refresh whose vault list succeeded, before deciding that a
 * provider has no vault account. Every member a successful list commits holds
 * an account list in memory, even an empty one, so a member holding none
 * means its share of the list was not saved: its roster file could not be
 * written, or its lock was held past the wait. That says nothing about the
 * vault's accounts, so one more refresh is tried. Returns why the list is
 * still unsaved after it, or undefined once the member holds a list.
 */
export async function unsavedRosterCause(
  core: RosterCore,
  provider: string,
): Promise<string | undefined> {
  const consumer = core.consumers.get(provider)
  if (!consumer || consumer.snapshot()) return undefined
  core.memberErrors.delete(provider)
  try {
    await core.hub.refresh()
  } catch (error) {
    return rosterFailureCause(error)
  }
  if (consumer.snapshot()) return undefined
  return rosterFailureCause(core.memberErrors.get(provider))
}
