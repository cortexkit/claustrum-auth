import { expect, test } from 'bun:test'
import { vaultMenuText } from '../src/menu.ts'
import { harness, row } from './fakes.ts'

test('vault menu shows ordered accounts, classification refusals, watch and provider state without local actions', async () => {
  const h = await harness([
    row('first'),
    row('second'),
    row('reserved', { providerIds: ['openai'] }),
    row('dedicated', { authMethod: 'chatgpt' }),
  ])
  const text = await vaultMenuText({
    ...h,
    authority: async () => 'vault',
    providerStatus: (provider) =>
      provider === 'fixture-a' ? 'owned' : 'available',
    latestRefusal: new Map([['fixture-a', 'origin-refused']]),
  })
  expect(text).toContain('Vault mode: on')
  expect(text).toContain('Watch: polling')
  expect(text).toContain('Outage receipts: none')
  expect(text).toContain('fixture-a: owned')
  expect(text).toContain('Latest request refusal: origin-refused')
  expect(text).toContain('reserved: reserved-provider')
  expect(text).toContain('Rows left to other plugins: 1')
  const rows = h.consumer.snapshot()?.rows ?? []
  expect(rows).toHaveLength(2)
  expect(text.indexOf(rows[0]?.routeId ?? '')).toBeLessThan(
    text.indexOf(rows[1]?.routeId ?? ''),
  )
  expect(text).toContain('active, enabled')
  expect(text).not.toMatch(
    /sign.in|add account|remove account|delete all|quota/iu,
  )
  expect(h.reads).toEqual([])
})

test('reorder commits the requested complete order and refuses incomplete or unknown orders', async () => {
  const h = await harness([row('first'), row('second')])
  const options = {
    ...h,
    authority: async () => 'vault' as const,
    providerStatus: () => 'owned',
  }
  const ids = h.consumer.snapshot()?.rows.map((row) => row.routeId) ?? []
  const text = await vaultMenuText(
    options,
    `reorder fixture-a ${ids[1]} ${ids[0]}`,
  )
  expect(text).toContain('order reordered')
  expect(h.consumer.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
    'second',
    'first',
  ])
  expect(await vaultMenuText(options, `reorder fixture-a ${ids[0]}`)).toContain(
    'order refused',
  )
  expect(await vaultMenuText(options, 'reorder fixture-a unknown')).toContain(
    'order refused',
  )
  expect(h.consumer.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
    'second',
    'first',
  ])
  expect(h.reads).toEqual([])
})

test('every render re-reads enrollment and an off or unreadable mode cannot reorder or show stale accounts', async () => {
  const h = await harness()
  let mode: 'vault' | 'local' | 'unreadable' = 'vault'
  let reads = 0
  const options = {
    ...h,
    authority: async () => {
      reads++
      return mode
    },
    providerStatus: () => 'owned',
  }
  expect(await vaultMenuText(options)).toContain('Vault mode: on')
  mode = 'local'
  expect(await vaultMenuText(options, 'status')).toContain('Vault mode: off')
  expect(await vaultMenuText(options, 'accounts')).not.toContain('account-a')
  expect(await vaultMenuText(options, 'reorder fixture-a unknown')).toContain(
    'no order was changed',
  )
  mode = 'unreadable'
  expect(await vaultMenuText(options)).toContain('Vault mode: unreadable')
  expect(reads).toBe(5)
})

test('status distinguishes an unreachable vault from unused outage receipts and an unreadable host slot', async () => {
  const h = await harness()
  const text = await vaultMenuText(
    {
      authority: async () => 'vault',
      consumers: h.consumers,
      providerStatus: async () => {
        throw new Error('cannot read host slot')
      },
      hub: {
        refresh: async () => {
          throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
        },
        watchState: () => h.hub.watchState(),
        keptReceiptState: () => h.hub.keptReceiptState(),
        refusals: () => h.hub.refusals(),
      },
    },
    'status',
  )
  expect(text).toContain('Vault: unreachable')
  expect(text).toContain('Outage receipts: none')
  expect(text).toContain('fixture-a: unreadable')
  expect(text).not.toContain('cannot read host slot')
})

test('account state shows declines for the account but not for a replacement account on the same credential', async () => {
  const rows = [row('first'), row('second')]
  const h = await harness(rows)
  const first = h.consumer
    .snapshot()
    ?.rows.find((row) => row.credentialId === 'first')
  expect(first).toBeDefined()
  await h.consumer.decline(first?.routeId as string)
  const options = {
    ...h,
    authority: async () => 'vault' as const,
    providerStatus: () => 'owned',
  }
  expect(await vaultMenuText(options, 'accounts')).toContain(', declined')
  rows[0] = row('first', { accountId: 'replacement-account' })
  expect(await vaultMenuText(options, 'accounts')).not.toContain(', declined')
  expect(h.reads).toEqual([])
})
