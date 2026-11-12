import { installRoutingAccessor } from './routing-accessor-fixture.ts'

export function routing(answer: (call: number) => Promise<unknown>) {
  const calls: unknown[] = []
  const reports: unknown[] = []
  installRoutingAccessor((session: string) => ({
    accountFor: (request: unknown, options: unknown) => {
      calls.push({ session, request, options })
      return answer(calls.length)
    },
    report: (payload: unknown) => reports.push(payload),
  }))
  return { calls, reports }
}
