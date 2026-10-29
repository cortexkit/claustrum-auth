// The real-host test entry. OpenCode 1 loads this file by path, so it is never
// part of the published package. It builds the OpenCode 1 plugin over the
// fixture providers, with their allowed origin set to the test's loopback mock,
// and a fake vault driven by a control file the test rewrites while the host
// runs. Every vault call is appended to a log the test reads.
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import type { PluginModule } from '@opencode-ai/plugin'
import {
  createTestCore,
  fixtureEntries,
  pluginId,
  supportedProviders,
} from '../../../core/test-entry.ts'
import { opencode1Hosts } from '../../src/v1/plugin.ts'

export {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'

export interface VaultControl {
  active: boolean
  outage: boolean
  rows: ScopedInventoryRow[]
  served: Record<
    string,
    { material: string; accountId?: string | null; recordVersion?: number }
  >
}

const dir = process.env.CLAUSTRUM_AUTH_E2E_DIR ?? ''
const origin = process.env.CLAUSTRUM_AUTH_E2E_ORIGIN ?? ''
const control = (): VaultControl =>
  JSON.parse(readFileSync(path.join(dir, 'vault.json'), 'utf8'))

export function fixtureClient(directory: string): ClaustrumScopedClient {
  const control = (): VaultControl =>
    JSON.parse(readFileSync(path.join(directory, 'vault.json'), 'utf8'))
  const log = (entry: Record<string, unknown>) =>
    appendFileSync(
      path.join(directory, 'vault-log.jsonl'),
      `${JSON.stringify(entry)}\n`,
    )
  const offline = () =>
    Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })

  return {
    async listScoped() {
      const state = control()
      log({ op: 'list' })
      if (state.outage) throw offline()
      return {
        rows: state.rows as never,
        view: createHash('sha256')
          .update(JSON.stringify(state.rows))
          .digest('hex')
          .slice(0, 16),
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      const state = control()
      log({ op: 'get', credentialId })
      if (state.outage) throw offline()
      const served = state.served[credentialId]
      if (!served) throw new Error('fixture vault has no material')
      return {
        credentialId,
        material: served.material,
        accountId:
          served.accountId === null
            ? undefined
            : (served.accountId ??
              state.rows.find((row) => row.id === credentialId)?.accountId),
        recordVersion: served.recordVersion ?? 1,
        expiresAtMs:
          state.rows.find((row) => row.id === credentialId)?.authMethod ===
          'oauth'
            ? Date.now() + 3_600_000
            : null,
      }
    },
    async reportAuthFailureScoped(input) {
      log({ op: 'report', ...input })
    },
    close() {},
  }
}
const client = fixtureClient(dir)

const table = [
  ...fixtureEntries,
  ...(process.env.CLAUSTRUM_AUTH_E2E_REAL_ROWS === '1'
    ? supportedProviders
    : []),
].map((entry) => ({
  ...entry,
  origins: [origin],
}))

const plugin = {
  id: pluginId,
  server: async (input) =>
    opencode1Hosts(
      {
        table,
        createCore: (options) => createTestCore(options, table),
        ...(process.env.CLAUSTRUM_AUTH_E2E_SETUP === '1'
          ? {}
          : {
              stateDir: () => path.join(dir, 'state'),
              isCustodyActive: async () => control().active,
            }),
        connect: async () => client,
      },
      input,
    ),
} satisfies PluginModule

export default plugin
