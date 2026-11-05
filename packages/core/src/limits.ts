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
  type LimitsNamespace,
  type LimitsRegistry,
  markFromSignal,
  sameAccount,
  statusVaultOrder,
} from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import { isBalanceFailure } from './balance.js'
import { ClaustrumAuthError } from './placement.js'

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
  paymentProbe: boolean
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
  const producerId = randomUUID()
  let hydrated: LimitsNamespace | undefined
  const registry: LimitsRegistry = await acquireLimitsRegistry({
    adapter: {
      ...adapter,
      async read(previous) {
        const view = await adapter.read(previous)
        if (view.authoritative) hydrated = view.snapshot
        return view
      },
    },
    isAccessRestrictive: () => false,
    onRejected(command) {
      if (command.producerId === producerId && command.type === 'clear') {
        // A rejected clear did not consume recovery evidence. Let the next
        // accepted view re-arm its probe instead of suppressing recovery.
        seenEvidence.delete(probeKey(command.binding.account))
        consumedHydration = undefined
      }
    },
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
  // An existing owner can supply the registry without using this adapter.
  // Read its initial recovery evidence once, never once per provider request.
  if (!hydrated) {
    try {
      const view = await adapter.read()
      if (view.authoritative) hydrated = view.snapshot
    } catch (error) {
      await registry.dispose().catch(() => {})
      throw error
    }
  }
  // Recovery evidence survives expiry pruning, but never controls eligibility.
  // Remember each mark only once so a consumed clear cannot re-arm itself.
  const rateDeadlines = new Map<string, number>()
  const paymentDeadlines = new Map<string, number>()
  const seenEvidence = new Map<string, string>()
  let consumedHydration: string | undefined
  const probeKey = (account: IdentityBinding['account']) =>
    JSON.stringify([account.namespace, account.accountId, account.incarnation])
  const retainDeadline = (
    key: string,
    cause: LimitMarkCause | undefined,
    until: number,
  ) => {
    rateDeadlines.delete(key)
    paymentDeadlines.delete(key)
    if (cause === 'rate-limit') rateDeadlines.set(key, until)
    if (cause === 'payment-balance') paymentDeadlines.set(key, until)
  }
  const remember = (snapshot: LimitsNamespace) => {
    for (const mark of snapshot.marks) {
      if (mark.key.scope.kind !== 'pool' || mark.key.window !== 'retry')
        continue
      const key = probeKey(mark.key.account)
      for (const entry of mark.entries) {
        if (!Number.isFinite(entry.until)) continue
        // A pending mark can receive a different committed revision on flush.
        // Its original observation still needs only one recovery clear.
        const evidence = JSON.stringify([
          snapshot.generation,
          entry.baseRevision,
          entry.evidenceAt,
          entry.until,
          entry.cause,
        ])
        if (seenEvidence.get(key) === evidence) continue
        seenEvidence.set(key, evidence)
        retainDeadline(key, entry.cause, entry.until)
      }
    }
  }
  const snapshotWithProbeEvidence = () => {
    const snapshot = registry.snapshot
    // The adapter's authoritative load retains expired entries; the registry's
    // public view prunes them. Only consume a load the registry accepted, not a
    // stale read that completed after a newer commit.
    if (
      hydrated &&
      hydrated.namespace === snapshot.namespace &&
      hydrated.generation === snapshot.generation &&
      hydrated.revision === snapshot.revision
    ) {
      const key = JSON.stringify([hydrated.generation, hydrated.revision])
      if (consumedHydration !== key) {
        consumedHydration = key
        remember(hydrated)
      }
    }
    remember(snapshot)
    return snapshot
  }
  const binding = (route: string): IdentityBinding => {
    const row = options.consumer
      .snapshot()
      ?.rows.find((row) => row.routeId === route)
    if (!row) throw new ClaustrumAuthError('route-gone')
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
    const snapshot = snapshotWithProbeEvidence()
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
      snapshotWithProbeEvidence()
      const current = binding(route)
      return {
        ...registry.observe(current),
        observedAt: now(),
        rateProbe:
          (rateDeadlines.get(probeKey(current.account)) ??
            Number.POSITIVE_INFINITY) <= now(),
        paymentProbe: paymentDeadlines.has(probeKey(current.account)),
      }
    },
    mark(observation, mark, evidenceAt = now()) {
      const key = probeKey(observation.binding.account)
      retainDeadline(key, mark.cause, mark.until)
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
        rateDeadlines.delete(probeKey(observation.binding.account))
      if (cause === 'payment-balance')
        paymentDeadlines.delete(probeKey(observation.binding.account))
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
