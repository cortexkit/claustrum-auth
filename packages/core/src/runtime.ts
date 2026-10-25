import {
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
      version: 1,
      facts,
      table,
      reservedProviders,
      members,
    },
    members,
    family: classifyingFamily(facts, table),
  })
  const consumers = new Map(
    members.map((provider) => [provider, hub.member(provider, {})]),
  )
  return { hub, consumers, entries }
}
