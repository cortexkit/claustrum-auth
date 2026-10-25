import { afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { createTestCore, fixtureEntries, type Host } from '../test-entry.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

export function row(
  id: string,
  overrides: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return {
    id,
    accountId: `account-${id}`,
    categories: ['llm-provider'],
    credentialType: 'api_key',
    authMethod: 'apikey',
    providerIds: ['fixture-a'],
    serves: [],
    operations: ['read'],
    state: 'active',
    recordVersion: 1,
    createdAtMs: null,
    ...overrides,
  }
}

export async function harness(rows = [row('a')], host: Host = 'opencode1') {
  const scratch = path.join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'target',
    'scratch',
  )
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'core-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const tokenPath = path.join(dir, 'token.json')
  await writeJsonAtomic(tokenPath, {
    token: '01'.repeat(32),
    token_generation: 1,
  })
  const reads: string[] = []
  const reports: Parameters<
    ClaustrumScopedClient['reportAuthFailureScoped']
  >[0][] = []
  let lists = 0
  let closed = 0
  let active = true
  let version = 1
  let outage = false
  let get: ClaustrumScopedClient['getScoped'] = async ({ credentialId }) => ({
    credentialId,
    material: `secret-${credentialId}-${version}`,
    accountId: rows.find((r) => r.id === credentialId)?.accountId,
    recordVersion: version,
    expiresAtMs: null,
  })
  const client: ClaustrumScopedClient = {
    async listScoped() {
      lists++
      return { rows, view: 'view-1', grants: undefined, grantTuples: undefined }
    },
    async getScoped(input) {
      reads.push(input.credentialId)
      if (outage)
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
      return get(input)
    },
    async reportAuthFailureScoped(input) {
      reports.push(input)
    },
    close() {
      closed++
    },
  }
  const catalog = fixtureEntries.map((entry) => entry.hosts[host] as string)
  const core = createTestCore({
    stateDir: dir,
    tokenPath,
    connect: async () => client,
    isCustodyActive: () => active,
    facts: {
      host,
      catalog,
      integrations: Object.fromEntries(catalog.map((id) => [id, id])),
    },
  })
  cleanup.push(() => core.hub.dispose())
  await core.hub.refresh()
  const consumer = core.consumers.get('fixture-a')
  if (!consumer) throw new Error('missing fixture-a member')
  return {
    ...core,
    reads,
    reports,
    client,
    stats: () => ({ lists, closed }),
    setActive(value: boolean) {
      active = value
    },
    setVersion(value: number) {
      version = value
    },
    setGet(value: typeof get) {
      get = value
    },
    setOutage(value: boolean) {
      outage = value
    },
    consumer,
  }
}

export const placeholder = 'owned-placeholder'
export const bearer = { authorization: `Bearer ${placeholder}` }
