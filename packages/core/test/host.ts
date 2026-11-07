import { onTestFinished } from 'bun:test'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'

/** Installs a per-call owned relay client and restores the ambient host after a test. */
export function installVaultHost(client?: ClaustrumScopedClient) {
  const key = Symbol.for('cortexkit.vault')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const marker = process.env.CORTEXKIT_VAULT_HOST
  const calls: string[] = []
  let closed = 0
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  delete globals[key]
  if (client)
    globals[key] = (id: string) => {
      calls.push(id)
      return {
        ...client,
        close() {
          closed++
        },
      }
    }
  onTestFinished(() => {
    if (marker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
    else process.env.CORTEXKIT_VAULT_HOST = marker
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  })
  return { calls, closed: () => closed }
}
