import { onTestFinished } from 'bun:test'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'

let restoring = false

/** Installs a per-call owned relay client and restores the ambient host after a test. */
export function installVaultHost(client?: ClaustrumScopedClient) {
  const key = Symbol.for('cortexkit.vault')
  const globals = globalThis as unknown as Record<symbol, unknown>
  if (!restoring) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    const marker = process.env.CORTEXKIT_VAULT_HOST
    restoring = true
    // Nested relay installs share one ambient restore. Per-call restores run
    // in registration order and would otherwise reinstall a previous relay.
    onTestFinished(() => {
      restoring = false
      if (marker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
      else process.env.CORTEXKIT_VAULT_HOST = marker
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
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
  return { calls, closed: () => closed }
}
