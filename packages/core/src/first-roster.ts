import type { ClaustrumConsumer } from '@cortexkit/common-auth/claustrum'
import { ClaustrumAuthError } from './placement.js'

export const firstRosterWaitMs = 2_000
const firstRosterTimeout = Symbol.for('claustrum-auth:first-roster-timeout')

// Kept internal so tests can advance the deadline without sleeping.
export const firstRosterClock = {
  schedule(run: () => void, ms: number): () => void {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

export async function waitForFirstRoster(
  consumer: Partial<Pick<ClaustrumConsumer, 'snapshot' | 'refresh'>>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (!consumer.snapshot || consumer.snapshot() || !consumer.refresh) return
  // Hub members share a coalesced refresh: joining discovery here does not
  // list once per request. An absent roster is not an empty account list.
  const discovery = consumer.refresh()
  let cancel: (() => void) | undefined
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = firstRosterClock.schedule(
        () =>
          reject(
            Object.assign(new ClaustrumAuthError('no-vault-account'), {
              cause: firstRosterTimeout,
            }),
          ),
        firstRosterWaitMs,
      )
      abort = () => reject(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      // A failed discovery leaves the usual empty-row refusal to the caller;
      // it is not evidence of a usable account.
      discovery.then(
        () => resolve(),
        () => resolve(),
      )
      if (signal?.aborted) abort()
    })
  } finally {
    cancel?.()
    if (abort) signal?.removeEventListener('abort', abort)
  }
  signal?.throwIfAborted()
}
