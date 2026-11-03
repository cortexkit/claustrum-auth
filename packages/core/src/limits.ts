import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ClaustrumConsumer } from '@cortexkit/common-auth/claustrum'
import {
  acquireLimitsRegistry,
  type IdentityBinding,
  type LimitHost,
  type LimitSignal,
  type LimitsRegistry,
  markFromSignal,
  sameAccount,
  statusVaultOrder,
} from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import { balanceProbeMs, isBalanceFailure } from './balance.js'

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
  // statusVaultOrder lacks the shipped five-minute payment default. Keep that
  // arithmetic until the shared payment marker and refusal contract is extended.
  if (signal.kind === 'payment-balance')
    return (
      (host === 'opencode2' ? now : signal.observedAt) +
      (signal.retryAfterMs ?? balanceProbeMs)
    )
  return markFromSignal(signal, statusVaultOrder.markers[host], { now })?.until
}

export interface LimitObservation {
  binding: IdentityBinding
  baseRevision: number
  observedAt: number
  hadMark: boolean
}

export interface AccountLimits {
  marks(): Promise<Map<string, number>>
  beforeDispatch(route: string): Promise<boolean>
  observe(route: string): LimitObservation
  mark(observation: LimitObservation, until: number): void
  clear(observation: LimitObservation): void
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
  // Expiry pruning removes timers from the registry view. Remember which
  // accounts had one so a successful probe clears with a tombstone, without
  // turning every healthy request into a control write.
  const marked = new Set<string>()
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
  return {
    async marks() {
      if (now() - registry.lastReloadAt >= 1000) await registry.reload()
      const marks = new Map<string, number>()
      for (const row of options.consumer.routingRows()) {
        const current = binding(row.id)
        for (const mark of registry.snapshot.marks) {
          if (
            !sameAccount(mark.key.account, current.account) ||
            mark.key.scope.kind !== 'pool' ||
            mark.key.window !== 'retry'
          )
            continue
          for (const entry of mark.entries)
            marks.set(row.id, Math.max(marks.get(row.id) ?? 0, entry.until))
          marked.add(JSON.stringify(current.account))
        }
      }
      if (registry.lastFailure) options.onError?.(registry.lastFailure)
      return marks
    },
    async beforeDispatch(route) {
      return !(await registry.beforeDispatch(binding(route))).blocked
    },
    observe(route) {
      const current = binding(route)
      return {
        ...registry.observe(current),
        observedAt: now(),
        hadMark: marked.has(JSON.stringify(current.account)),
      }
    },
    mark(observation, until) {
      marked.add(JSON.stringify(observation.binding.account))
      registry.enqueue({
        ...observation,
        producerId,
        operationId: randomUUID(),
        type: 'mark',
        ...target,
        until,
        evidenceAt: now(),
        mergeLaw: 'overwrite',
      })
    },
    clear(observation) {
      marked.delete(JSON.stringify(observation.binding.account))
      registry.enqueue(
        {
          ...observation,
          producerId,
          operationId: randomUUID(),
          type: 'clear',
          keys: [target],
          evidenceAt: observation.observedAt,
        },
        'success',
      )
    },
    flush: () => registry.flush(),
    dispose: () => registry.dispose(),
  }
}

const localRefusals = new WeakSet<Response>()
export function localLimitRefusal(response: Response) {
  localRefusals.add(response)
  return response
}
export function isLocalLimitRefusal(response: Response) {
  return localRefusals.has(response)
}
