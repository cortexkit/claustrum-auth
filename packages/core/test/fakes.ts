import { onTestFinished } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import {
  createTestCore,
  fixtureEntries,
  type Host,
  type ProviderEntry,
  supportedProviders,
} from '../test-entry.ts'

const cleanup: (() => Promise<unknown>)[] = []
// Every scratch folder this helper created that has not been removed yet.
const liveDirs = new Set<string>()
let armed = false

/**
 * Runs `close` when the current test finishes, pass or fail.
 *
 * `bun test` loads this module once for all the test files of a run, so an
 * `afterEach` at the top of this file would be attached only to the first
 * file that imported it, and every later file would leave its scratch
 * folders behind with its hubs undisposed. `onTestFinished` attaches to
 * whichever test is running, in any file.
 */
function afterThisTest(close: () => Promise<unknown>) {
  if (!armed) {
    onTestFinished(async () => {
      armed = false
      for (const close of cleanup.splice(0).reverse()) await close()
      const left = [...liveDirs]
      if (left.length)
        throw new Error(`scratch folder left behind (${left.join(', ')})`)
    })
    armed = true
    // A scratch folder still present when a test starts outlived the test
    // that created it: remove it with this test's cleanup, and fail this
    // test.
    const leaked = [...liveDirs]
    if (leaked.length) {
      cleanup.push(...leaked.map((dir) => () => removeScratch(dir)), close)
      throw new Error(
        `scratch folder from an earlier test is still present (${leaked.join(', ')})`,
      )
    }
  }
  cleanup.push(close)
}

async function removeScratch(dir: string) {
  await rm(dir, { recursive: true, force: true })
  liveDirs.delete(dir)
}

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
  return withTable(rows, host, fixtureEntries, 'fixture-a')
}

// The same harness over the shipped table: the hub's members and the vault
// rows are the live providers a real host serves.
export async function liveHarness(
  rows: ScopedInventoryRow[],
  host: Host = 'opencode1',
) {
  return withTable(
    rows,
    host,
    supportedProviders,
    supportedProviders[0]?.service as string,
  )
}

async function withTable(
  rows: ScopedInventoryRow[],
  host: Host,
  table: readonly ProviderEntry[],
  firstMember: string,
) {
  // common-auth writes these files owner-only and refuses a parent folder that
  // other users may change. A Windows CI checkout (D:\a\...) is such a folder,
  // so on Windows the scratch goes in the user's own temp folder instead.
  const scratch =
    process.platform === 'win32'
      ? path.join(os.tmpdir(), 'claustrum-auth-scratch')
      : path.join(import.meta.dir, '..', '..', '..', 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'core-'))
  // Arm this test's cleanup before tracking the folder: the leak check
  // above must not see the folder this test just created.
  afterThisTest(() => removeScratch(dir))
  liveDirs.add(dir)
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
  let get: ClaustrumScopedClient['getScoped'] = async ({ credentialId }) => {
    const listed = rows.find((r) => r.id === credentialId)
    return {
      credentialId,
      material: `secret-${credentialId}-${version}`,
      accountId: listed?.accountId,
      recordVersion: version,
      // Custody refuses an OAuth read with no expiry, so an OAuth row is served
      // with an hour left, as the vault serves a minted token.
      expiresAtMs:
        listed?.credentialType === 'oauth' ? Date.now() + 3_600_000 : null,
    }
  }
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
  const catalog = table.flatMap((entry) => {
    const id = entry.hosts[host]
    return id ? [id] : []
  })
  const core = createTestCore(
    {
      stateDir: dir,
      tokenPath,
      connect: async () => client,
      isCustodyActive: () => active,
      facts: {
        host,
        catalog,
        integrations: Object.fromEntries(catalog.map((id) => [id, id])),
      },
    },
    table,
  )
  afterThisTest(() => core.hub.dispose())
  await core.hub.refresh()
  const consumer = core.consumers.get(firstMember)
  if (!consumer) throw new Error(`missing ${firstMember} member`)
  return {
    ...core,
    reads,
    reports,
    client,
    dir,
    // The material the fake vault serves for a row at its current version.
    secretOf: (credentialId: string) => `secret-${credentialId}-${version}`,
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

// The operator's vault row for a shipped entry: the fleet's provider id, or,
// for an entry served by exact credential id, that credential with no
// provider id at all. Meta and xAI are OAuth rows in the operator's vault.
export function vaultRowFor(
  entry: ProviderEntry,
  overrides: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  const byCredential = entry.credentialIds?.[0]
  const oauth = entry.service === 'meta' || entry.service === 'xai'
  return row(byCredential ?? `${oauth ? 'oauth' : 'apikey'}:${entry.service}`, {
    providerIds: byCredential ? [] : [entry.ids[0] as string],
    ...(oauth ? { credentialType: 'oauth', authMethod: 'oauth' } : {}),
    ...overrides,
  })
}
