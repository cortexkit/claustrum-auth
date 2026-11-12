import { onTestFinished } from 'bun:test'

const symbol = Symbol.for('cortexkit.routing')
let restoring = false

export function installRoutingAccessor(accessor?: unknown) {
  if (!restoring) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, symbol)
    restoring = true
    // Several helpers can replace the accessor in one test. Restore the
    // original once, not an intermediate accessor from an earlier helper.
    onTestFinished(() => {
      restoring = false
      if (previous) Object.defineProperty(globalThis, symbol, previous)
      else Reflect.deleteProperty(globalThis, symbol)
    })
  }
  if (accessor === undefined) Reflect.deleteProperty(globalThis, symbol)
  else
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: accessor,
    })
}
