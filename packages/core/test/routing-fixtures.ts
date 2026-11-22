import { installRoutingAccessor } from './routing-accessor-fixture.ts'

export function routing(answer: (call: number) => Promise<unknown>) {
  const calls: {
    session: string
    request: Record<string, unknown>
    options: unknown
  }[] = []
  const reports: unknown[] = []
  installRoutingAccessor((session: string) => ({
    accountFor: (request: Record<string, unknown>, options: unknown) => {
      calls.push({ session, request, options })
      return answer(calls.length)
    },
    report: (payload: unknown) => reports.push(payload),
  }))
  return { calls, reports }
}

export function capacityRouting(accountId: string, onFull?: () => void) {
  const timing = { resetsAtMs: 0, askedAgainAtMs: 0 }
  const capture = routing(async (call) => {
    if (call === 1) {
      timing.resetsAtMs = Date.now() + 100
      if (onFull) setTimeout(onFull, 0)
      return {
        refused: { code: 'concurrency_full', resets_at_ms: timing.resetsAtMs },
      }
    }
    timing.askedAgainAtMs = Date.now()
    return { account_id: accountId }
  })
  return { ...capture, timing }
}
