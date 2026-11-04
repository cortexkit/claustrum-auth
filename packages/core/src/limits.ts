import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ClaustrumConsumer } from '@cortexkit/common-auth/claustrum'
import {
  acquireLimitsRegistry,
  buildRefusal,
  clearLimitsAfterProbe,
  type HostRetry,
  type IdentityBinding,
  type LimitCandidate,
  type LimitDecision,
  type LimitHost,
  type LimitMark,
  type LimitMarkCause,
  type LimitSignal,
  type LimitsRegistry,
  markFromSignal,
  sameAccount,
  statusVaultOrder,
} from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import { isBalanceFailure } from './balance.js'

export interface ReplyFacts {
  account: IdentityBinding['account']
  service: string
  status: number
  headers: Headers
  body?: () => Promise<string>
  now: number
}

/** Provider balance rules stay separate from generic rate-limit header hints. */
export async function limitFromReply(input: ReplyFacts) {
  let balance = false
  if (input.status === 402) {
    let text: string | undefined
    if (input.service === 'openrouter') {
      try {
        text = await input.body?.()
      } catch {}
    }
    balance = isBalanceFailure(input.service, text)
    if (!balance) return undefined
  }
  if (input.status !== 429 && !balance) return undefined
  const raw = input.headers.get('retry-after')
  let retryAfterMs: number | undefined
  if (raw !== null) {
    const seconds = Number(raw)
    if (raw.trim() && Number.isFinite(seconds) && seconds >= 0)
      retryAfterMs = seconds * 1000
    else {
      // Preserve the provider parser's existing Date.parse acceptance rather
      // than narrowing it to the generic classifier's HTTP-date grammar.
      const date = Date.parse(raw)
      if (Number.isFinite(date) && date > input.now)
        retryAfterMs = date - input.now
    }
  }
  const signal: LimitSignal = {
    account: input.account,
    status: input.status,
    kind: balance ? 'payment-balance' : 'rate-limit',
    reason: balance ? 'payment-required' : 'rate-limit',
    scope: { kind: 'pool' },
    observedAt: input.now,
    windows: [
      {
        window: 'retry',
        confirmed: false,
        confirmedByReading: false,
        observedAt: input.now,
        provenance: 'http-status',
        ...(retryAfterMs === undefined
          ? {}
          : {
              resetAt: input.now + retryAfterMs,
              resetSource: 'retry-after',
            }),
      },
    ],
    ...(retryAfterMs === undefined
      ? {}
      : { retryAfterMs, retryAfterSource: 'retry-after' }),
  }
  return signal
}

export function limitMarkUntil(
  signal: LimitSignal,
  host: LimitHost,
  now: number,
) {
  return markFromSignal(signal, statusVaultOrder.markers[host], { now })?.until
}

export interface LimitObservation {
  binding: IdentityBinding
  baseRevision: number
  observedAt: number
  rateProbe: boolean
}

export interface AccountLimits {
  marks(): Promise<Map<string, number>>
  candidates(): Promise<LimitCandidate[]>
  beforeDispatch(route: string): Promise<boolean>
  observe(route: string): LimitObservation
  mark(
    observation: LimitObservation,
    mark: LimitMark,
    evidenceAt?: number,
  ): void
  clear(observation: LimitObservation, cause: LimitMarkCause): void
  flush(): Promise<void>
  dispose(): Promise<void>
}

export interface CoreLimits {
  limits?(provider: string): Promise<AccountLimits>
  disposeLimits?(): Promise<void>
}

export async function createAccountLimits(options: {
  provider: string
  path: string
  consumer: Pick<ClaustrumConsumer, 'snapshot' | 'routingRows'>
  now?: () => number
  onError?: (error: unknown) => void
}): Promise<AccountLimits> {
  const now = options.now ?? Date.now
  const namespace = JSON.stringify([
    'claustrum-auth',
    options.provider,
    resolve(options.path),
  ])
  const adapter = await createVaultLimitsAdapter({
    namespace,
    path: options.path,
    now,
  })
  const registry: LimitsRegistry = await acquireLimitsRegistry({
    adapter,
    isAccessRestrictive: () => false,
    clock: {
      now,
      setTimeout(callback, delay) {
        const timer = setTimeout(callback, delay)
        timer.unref?.()
        return timer
      },
      clearTimeout(timer) {
        clearTimeout(timer as ReturnType<typeof setTimeout>)
      },
    },
  })
  const producerId = randomUUID()
  // Retain observed rate deadlines after expiry pruning only to recognize a
  // recovery probe; routing still uses the registry's authoritative view.
  const rateDeadlines = new Map<string, number>()
  const binding = (route: string): IdentityBinding => {
    const row = options.consumer
      .snapshot()
      ?.rows.find((row) => row.routeId === route)
    if (!row) throw new Error('claustrum-auth: missing limit account binding')
    return {
      account: {
        namespace,
        accountId: route,
        incarnation: String(row.addedAt),
      },
      credentialEpoch: String(row.addedAt),
      ...(row.accountIdentity === undefined
        ? {}
        : { identity: row.accountIdentity }),
    }
  }
  const target = { scope: { kind: 'pool' as const }, window: 'retry' }
  const candidates = async (): Promise<LimitCandidate[]> => {
    if (now() - registry.lastReloadAt >= 1000) await registry.reload()
    const snapshot = registry.snapshot
    return options.consumer.routingRows().map((row) => {
      const current = binding(row.id)
      const blockers = snapshot.marks
        .filter(
          (mark) =>
            sameAccount(mark.key.account, current.account) &&
            mark.key.scope.kind === 'pool' &&
            mark.key.window === 'retry',
        )
        .flatMap((mark) =>
          mark.entries
            .filter((entry) => entry.until > now())
            .map((entry) => ({
              kind: 'hard' as const,
              until: entry.until,
              cause: entry.cause,
            })),
        )
      const key = JSON.stringify(current.account)
      for (const blocker of blockers) {
        if (blocker.cause === 'rate-limit')
          rateDeadlines.set(key, blocker.until)
        else rateDeadlines.delete(key)
      }
      return {
        account: current.account,
        admitted: true,
        placementEligible: true,
        ready: blockers.length === 0,
        blockers,
      }
    })
  }
  return {
    candidates,
    async marks() {
      const view = await candidates()
      if (registry.lastFailure) options.onError?.(registry.lastFailure)
      return new Map(
        view
          .filter((row) => !row.ready)
          .map((row) => [
            row.account.accountId,
            Math.max(...row.blockers.map((blocker) => blocker.until ?? 0)),
          ]),
      )
    },
    async beforeDispatch(route) {
      return !(await registry.beforeDispatch(binding(route))).blocked
    },
    observe(route) {
      const current = binding(route)
      return {
        ...registry.observe(current),
        observedAt: now(),
        rateProbe:
          (rateDeadlines.get(JSON.stringify(current.account)) ??
            Number.POSITIVE_INFINITY) <= now(),
      }
    },
    mark(observation, mark, evidenceAt = now()) {
      const key = JSON.stringify(observation.binding.account)
      if (mark.cause === 'rate-limit') rateDeadlines.set(key, mark.until)
      else rateDeadlines.delete(key)
      registry.enqueue({
        ...observation,
        producerId,
        operationId: randomUUID(),
        type: 'mark',
        ...target,
        until: mark.until,
        cause: mark.cause,
        evidenceAt,
        mergeLaw: mark.mergeLaw,
      })
    },
    clear(observation, cause) {
      if (cause === 'rate-limit')
        rateDeadlines.delete(JSON.stringify(observation.binding.account))
      // A fresh process may start after expiry pruned the timer. Publish a
      // recovery fence even when no mark remains in its current view.
      clearLimitsAfterProbe(registry, {
        ...observation,
        producerId,
        operationId: randomUUID(),
        keys: [target],
        evidenceAt: observation.observedAt,
        cause,
      })
    },
    flush: () => registry.flush(),
    dispose: () => registry.dispose(),
  }
}

const localRefusals = new WeakMap<Response, HostRetry>()
export function localLimitRefusal(
  response: Response,
  hostRetry: HostRetry = 'veto',
) {
  localRefusals.set(response, hostRetry)
  return response
}
export function isLocalLimitRefusal(response: Response) {
  return localRefusals.has(response)
}
export function localLimitRetry(response: Response) {
  return localRefusals.get(response)
}

export function limitRefusal(
  decision: Extract<LimitDecision, { action: 'refuse' }>,
  host: LimitHost,
  now: number,
) {
  if (
    decision.family !== 'claustrum-429' &&
    decision.family !== 'claustrum-402'
  )
    throw new Error('claustrum-auth: unsupported limit refusal family')
  const wire = buildRefusal({ ...decision, family: decision.family, host, now })
  if (wire.kind !== 'http')
    throw new Error('claustrum-auth: unsupported limit refusal')
  return localLimitRefusal(
    new Response(wire.body, { status: wire.status, headers: wire.headers }),
    wire.hostRetry,
  )
}
