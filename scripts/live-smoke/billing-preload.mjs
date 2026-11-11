import { appendFileSync } from 'node:fs'

// Import in the server before plugin setup. Never capture requests or headers.
const destination = process.env.CLAUSTRUM_AUTH_LIVE_BILLING
if (destination) {
  Reflect.set(globalThis, Symbol.for('cortexkit.routing'), () => ({
    report(payload) {
      if (payload.kind === 'billing')
        appendFileSync(destination, `${JSON.stringify(payload)}\n`, {
          mode: 0o600,
        })
    },
  }))
}
