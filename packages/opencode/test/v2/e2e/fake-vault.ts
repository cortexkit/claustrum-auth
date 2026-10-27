// A loopback fake of the Claustrum vault for the real-host tests. The plugin
// under test reaches it through the scoped-client shape the discovery hub
// expects (see plugin-entry.ts), so the hub, custody and consumers that run
// inside the host are the real ones; only the vault behind them is fake.
// Every call is counted, so a test can assert zero reads and exact reports.

export interface VaultRow {
  readonly id: string
  readonly providerIds: readonly string[]
  /** The account the listing names; undefined for none. */
  readonly accountId?: string
  /** The account `get_scoped` asserts; defaults to the listed one. */
  readonly servedAccountId?: string | null
}

export interface FakeVault {
  readonly url: string
  rows: VaultRow[]
  offline: boolean
  mode: 'vault' | 'local'
  version: number
  readonly reads: string[]
  readonly reports: {
    credentialId: string
    providerStatus: number
    recordVersion: number
  }[]
  lists: number
  /** The secret `get_scoped` serves for a row, at every version. */
  secret(id: string): string
  stop(): Promise<void>
}

export function startFakeVault(rows: VaultRow[]): FakeVault {
  const nonce = crypto.randomUUID().slice(0, 8)
  const vault: Omit<FakeVault, 'url' | 'stop'> = {
    rows,
    offline: false,
    mode: 'vault',
    version: 1,
    reads: [],
    reports: [],
    lists: 0,
    secret: (id) => `vault-secret-${id}-${nonce}`,
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const op = new URL(request.url).pathname.slice(1)
      if (op === 'mode') return Response.json({ result: vault.mode })
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      if (op === 'list') vault.lists++
      if (op === 'get') vault.reads.push(String(body.credentialId))
      if (vault.offline) return Response.json({ offline: true })
      if (op === 'list')
        return Response.json({
          result: {
            rows: vault.rows.map((row) => ({
              id: row.id,
              ...(row.accountId === undefined
                ? {}
                : { accountId: row.accountId }),
              categories: ['llm-provider'],
              credentialType: 'api_key',
              authMethod: 'apikey',
              providerIds: row.providerIds,
              serves: [],
              operations: ['read'],
              state: 'active',
              recordVersion: vault.version,
              createdAtMs: null,
            })),
            view: `view-${vault.version}-${vault.rows.map((row) => row.id).join(',')}`,
          },
        })
      if (op === 'get') {
        const row = vault.rows.find((entry) => entry.id === body.credentialId)
        if (!row) return Response.json({ error: 'not_found' })
        const account =
          row.servedAccountId === undefined
            ? row.accountId
            : (row.servedAccountId ?? undefined)
        return Response.json({
          result: {
            credentialId: row.id,
            material: vault.secret(row.id),
            ...(account === undefined ? {} : { accountId: account }),
            recordVersion: vault.version,
            expiresAtMs: null,
          },
        })
      }
      if (op === 'report') {
        vault.reports.push(body as FakeVault['reports'][number])
        return Response.json({ result: null })
      }
      return Response.json({ error: 'unknown_module' })
    },
  })
  return Object.assign(vault, {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  })
}
