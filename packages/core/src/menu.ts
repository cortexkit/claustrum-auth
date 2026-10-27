import { Readable, Writable } from 'node:stream'
import { type MenuAction, runMenu } from '@cortexkit/common-auth/auth-menu'
import type {
  ClaustrumConsumer,
  ClaustrumDiscoveryHub,
} from '@cortexkit/common-auth/claustrum'
import {
  classifyVaultFailure,
  isDeclined,
} from '@cortexkit/common-auth/claustrum'
import { command } from './names.js'

export type MenuConsumer = Pick<ClaustrumConsumer, 'snapshot' | 'reorder'>
export type MenuHub = Pick<
  ClaustrumDiscoveryHub,
  'watchState' | 'keptReceiptState' | 'refusals' | 'refresh'
>

export interface VaultMenuOptions {
  authority(): Promise<'vault' | 'local' | 'unreadable'>
  hub: MenuHub
  consumers: ReadonlyMap<string, MenuConsumer>
  providerStatus(provider: string): string | Promise<string>
  latestRefusal?: ReadonlyMap<string, string>
}

export const menuUsage = `${command} [status | accounts | refusals | reorder <provider> <route-id> ...]`

/** A text-only projection of the shared menu; it never reads host stdin. */
export async function vaultMenuText(
  options: VaultMenuOptions,
  args = '',
): Promise<string> {
  // Re-read enrollment even for account lists and refused reorder requests.
  const authority = await options.authority().catch(() => 'unreadable' as const)
  const [verb = '', provider, ...ids] = args.trim().split(/\s+/u)
  if (verb === 'reorder') {
    if (authority !== 'vault')
      return 'claustrum-auth: vault mode is off or unreadable; no order was changed.'
    const consumer = provider && options.consumers.get(provider)
    if (!consumer || !ids.length) return menuUsage
    try {
      const result = await consumer.reorder(ids)
      return `claustrum-auth: ${provider} order ${result.outcome}.`
    } catch {
      return 'claustrum-auth: order refused; include every route id exactly once, in the desired order.'
    }
  }
  if (verb && !['status', 'accounts', 'refusals'].includes(verb))
    return menuUsage
  if (provider) return menuUsage
  let reachability: string =
    authority === 'vault'
      ? 'reachable'
      : authority === 'local'
        ? 'off'
        : 'unreadable'
  if (authority === 'vault') {
    try {
      await options.hub.refresh()
    } catch (error) {
      reachability =
        classifyVaultFailure(error) === 'unreachable'
          ? 'unreachable'
          : 'refused'
    }
  }
  const status: string[] = []
  if (!verb || verb === 'status') {
    const outage = options.hub.keptReceiptState()
    status.push(
      `Vault mode: ${authority === 'vault' ? 'on' : authority === 'local' ? 'off' : 'unreadable'}`,
      `Watch: ${options.hub.watchState()}`,
      `Vault: ${reachability}`,
      `Outage receipts: ${outage.active ? 'active' : 'none'}`,
    )
    for (const provider of options.consumers.keys()) {
      let state: string
      try {
        state = await options.providerStatus(provider)
      } catch {
        state = 'unreadable'
      }
      status.push(`${provider}: ${state}`)
      const refusal = options.latestRefusal?.get(provider)
      if (refusal) status.push(`  Latest request refusal: ${refusal}`)
    }
  }
  if (!verb || verb === 'accounts') {
    status.push('Accounts (routing order):')
    for (const [provider, consumer] of options.consumers) {
      const roster = consumer.snapshot()
      const rows = authority === 'vault' ? (roster?.rows ?? []) : []
      status.push(`${provider}: ${rows.length} vault account(s)`)
      for (const [index, row] of rows.entries()) {
        const declined = isDeclined(
          roster?.declined ?? [],
          row.credentialId,
          row.accountIdentity,
        )
        status.push(
          `  ${index + 1}. ${row.label} [${row.routeId}]: ${row.state}, ${row.enabled ? 'enabled' : 'disabled'}${declined ? ', declined' : ''}${row.stale ? ', stale' : ''}`,
        )
      }
    }
    if (!options.consumers.size) status.push('No provider is available yet.')
  }
  if (!verb || verb === 'refusals') {
    const refusals = authority === 'vault' ? options.hub.refusals() : undefined
    status.push('Refused vault rows:')
    if (!refusals) status.push('Unknown (no current complete discovery).')
    else {
      for (const row of refusals.refused)
        status.push(`  ${row.credentialId ?? '(unnamed)'}: ${row.code}`)
      if (!refusals.refused.length) status.push('None.')
      status.push(`Rows left to other plugins: ${refusals.notMine}`)
    }
  }
  const actions: MenuAction[] = [
    { id: 'status', label: `${command} status`, run() {} },
    { id: 'accounts', label: `${command} accounts`, run() {} },
    { id: 'refusals', label: `${command} refusals`, run() {} },
    {
      id: 'reorder',
      label: `${command} reorder <provider> <route-id> ...`,
      run() {},
    },
  ]
  let text = ''
  await runMenu({
    title: 'claustrum-auth plugin',
    status,
    actions,
    terminal: {
      input: Object.assign(Readable.from([]), {
        isTTY: false,
        setRawMode() {},
      }),
      output: new Writable({
        write(chunk, _encoding, done) {
          text += String(chunk)
          done()
        },
      }),
    },
  })
  return text.trimEnd()
}
