import { appendFileSync } from 'node:fs'

// Loaded before plugin setup, in the real host process rather than the runner.
const destination = process.env.CLAUSTRUM_AUTH_E2E_BILLING
if (destination) {
  Reflect.set(globalThis, Symbol.for('cortexkit.routing'), () => ({
    report(payload: { kind: string }) {
      if (payload.kind === 'billing')
        appendFileSync(destination, `${JSON.stringify(payload)}\n`)
    },
  }))
}
