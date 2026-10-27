// A fake OpenCode 2 host context and a fake vault for the server entry's
// unit tests. The host fake only does what the installer and the login
// registration call: hook registration, transforms, the catalog read and an
// event stream that stays open until disposal.
import { afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import {
  createTestCore,
  fixtureEntries,
  type ProviderEntry,
} from '../../../core/test-entry.ts'
import { type ServerDeps, setupServer } from '../../src/v2/setup.ts'
import { scratchRoot } from '../scratch-root.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

export const origin = 'https://fixture.invalid'

export const table: readonly ProviderEntry[] = fixtureEntries.map((entry) => ({
  ...entry,
  origins: [origin],
}))

export function row(
  id: string,
  overrides: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return {
    id,
    accountId: `listed-${id}`,
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

type Hook = (draft: never) => unknown
interface Registered {
  callback: Hook
  providerID?: string
}

export interface FakeHost {
  ctx: Parameters<typeof setupServer>[0]
  hooks: Map<string, Registered[]>
  commands: Map<
    string,
    {
      execute(input: {
        sessionID: string
        prompt: { text: string }
      }): Promise<void>
    }
  >
  synthetic: { sessionID: string; text: string; resume: boolean }[]
  selected: Map<
    string,
    { type: 'oauth'; access: string } | { type: 'key'; key: string }
  >
  /** OAuth methods registered per integration, by method id. */
  methods: Map<
    string,
    {
      integrationID: string
      method: { id: string }
      authorize: (answer: unknown) => Promise<{ callback: Promise<unknown> }>
    }
  >
  dispose(): void
}

export function fakeHost(
  catalog: readonly { id: string; integrationID?: string }[],
): FakeHost {
  const hooks = new Map<string, Registered[]>()
  const commands: FakeHost['commands'] = new Map()
  const synthetic: FakeHost['synthetic'] = []
  const selected: FakeHost['selected'] = new Map()
  const methods: FakeHost['methods'] = new Map()
  const providerTransforms = new Set<(editor: unknown) => void>()
  const abort = new AbortController()
  const registration = (remove: () => void) => ({
    dispose: async () => remove(),
  })
  const ctx = {
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        const names: string[] = []
        callback({
          add(definition: { name: string; execute: never }) {
            names.push(definition.name)
            commands.set(definition.name, definition)
          },
        })
        return registration(() => {
          for (const name of names) commands.delete(name)
        })
      },
    },
    session: {
      synthetic: async (input: FakeHost['synthetic'][number]) => {
        synthetic.push(input)
      },
      hook: async (
        name: string,
        callback: Hook,
        options?: { providerID?: string },
      ) => {
        const entry = { callback, providerID: options?.providerID }
        const list = hooks.get(name) ?? []
        list.push(entry)
        hooks.set(name, list)
        return registration(() => list.splice(list.indexOf(entry), 1))
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) =>
            abort.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
        },
      }),
    },
    integration: {
      connection: {
        active: async (provider: string) =>
          selected.has(provider)
            ? { type: 'credential', label: 'renamed login', id: provider }
            : undefined,
        resolve: async (connection: { id: string }) =>
          selected.get(connection.id),
      },
      transform: async (callback: (editor: unknown) => void) => {
        const added: string[] = []
        callback({
          method: {
            update: (implementation: {
              integrationID: string
              method: { id: string; type: string }
              authorize: never
            }) => {
              if (implementation.method.type !== 'oauth') return
              const key = `${implementation.integrationID}:${implementation.method.id}`
              methods.set(key, implementation as never)
              added.push(key)
            },
          },
        })
        return registration(() => {
          for (const key of added) methods.delete(key)
        })
      },
    },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        providerTransforms.add(callback)
        return registration(() => providerTransforms.delete(callback))
      },
      get: async ({ providerID }: { providerID: string }) => {
        const record = catalog.find((entry) => entry.id === providerID)
        if (!record) throw new Error(`Provider not found: ${providerID}`)
        return {
          location: {},
          data: {
            id: record.id,
            ...(record.integrationID
              ? { integrationID: record.integrationID }
              : {}),
          },
        }
      },
      list: async () => {
        const editor = {
          list: () =>
            catalog.map((record) => ({
              provider: {
                id: record.id,
                ...(record.integrationID
                  ? { integrationID: record.integrationID }
                  : {}),
              },
              models: new Map(),
            })),
        }
        for (const transform of providerTransforms) transform(editor)
        return []
      },
    },
  } as unknown as FakeHost['ctx']
  return {
    ctx,
    hooks,
    methods,
    commands,
    synthetic,
    selected,
    dispose: () => abort.abort(),
  }
}

/** Runs every callback of a hook for a provider, as the host does. */
export async function trigger<T extends object>(
  host: FakeHost,
  name: string,
  draft: T & { model: { providerID: string } },
): Promise<T> {
  for (const hook of host.hooks.get(name) ?? []) {
    if (hook.providerID && hook.providerID !== draft.model.providerID) continue
    await (hook.callback as (draft: T) => unknown)(draft)
  }
  return draft
}

export interface FakeVault {
  rows: ScopedInventoryRow[]
  reads: string[]
  reports: Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0][]
  lists: number
  connects: number
  mode: 'vault' | 'local'
  offline: boolean
  /** Served account ids that differ from the listing (for class B). */
  served: Map<string, string | undefined>
  version: number
}

export async function startServer(
  options: {
    rows?: ScopedInventoryRow[]
    catalog?: readonly { id: string; integrationID?: string }[]
    offline?: boolean
    mode?: 'vault' | 'local'
    table?: readonly ProviderEntry[]
  } = {},
) {
  const scratch = scratchRoot()
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'opencode2-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const tokenPath = path.join(dir, 'token.json')
  await writeJsonAtomic(tokenPath, {
    token: '01'.repeat(32),
    token_generation: 1,
  })
  const vault: FakeVault = {
    rows: options.rows ?? [row('a1')],
    reads: [],
    reports: [],
    lists: 0,
    connects: 0,
    mode: options.mode ?? 'vault',
    offline: options.offline ?? false,
    served: new Map(),
    version: 1,
  }
  const unreachable = () =>
    Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  const client: ClaustrumScopedClient = {
    async listScoped() {
      vault.lists++
      if (vault.offline) throw unreachable()
      return {
        rows: vault.rows,
        view: `view-${vault.rows.map((r) => r.id).join(',')}`,
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      vault.reads.push(credentialId)
      if (vault.offline) throw unreachable()
      return {
        credentialId,
        material: `secret-${credentialId}-${vault.version}`,
        accountId: vault.served.has(credentialId)
          ? vault.served.get(credentialId)
          : vault.rows.find((r) => r.id === credentialId)?.accountId,
        recordVersion: vault.version,
        // Custody refuses an OAuth read with no expiry, so an OAuth row is
        // served with an hour left, as the vault serves a minted token.
        expiresAtMs:
          vault.rows.find((r) => r.id === credentialId)?.credentialType ===
          'oauth'
            ? Date.now() + 3_600_000
            : null,
      }
    },
    async reportAuthFailureScoped(input) {
      vault.reports.push(input)
    },
    close() {},
  }
  const host = fakeHost(
    options.catalog ??
      table.map((entry) => ({ id: entry.hosts.opencode2 as string })),
  )
  const errors: unknown[] = []
  const deps: ServerDeps = {
    table: options.table ?? table,
    authority: async () => vault.mode,
    createCore: (facts) =>
      createTestCore(
        {
          facts,
          stateDir: dir,
          tokenPath,
          isCustodyActive: () => vault.mode === 'vault',
          connect: async () => {
            vault.connects++
            if (vault.offline) throw unreachable()
            return client
          },
        },
        options.table ?? table,
      ),
    onError: (error) => errors.push(error),
  }
  const dispose = await setupServer(host.ctx, deps)
  cleanup.push(async () => {
    host.dispose()
    await dispose()
  })
  return { host, vault, errors, dir }
}

let sessions = 0
export function scope(providerID: string, kind = 'primary') {
  return {
    sessionID: `ses_${++sessions}`,
    agent: 'build',
    model: { providerID, id: 'model' },
    kind,
  }
}
