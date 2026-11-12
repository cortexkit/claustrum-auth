import { onTestFinished } from 'bun:test'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)

export function routing(answer: (call: number) => Promise<unknown>) {
  onTestFinished(() => {
    if (original) Object.defineProperty(globalThis, symbol, original)
    else Reflect.deleteProperty(globalThis, symbol)
  })
  const calls: unknown[] = []
  const reports: unknown[] = []
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: (session: string) => ({
      accountFor: (request: unknown, options: unknown) => {
        calls.push({ session, request, options })
        return answer(calls.length)
      },
      report: (payload: unknown) => reports.push(payload),
    }),
  })
  return { calls, reports }
}
