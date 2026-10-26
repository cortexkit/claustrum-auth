import {
  ClaustrumAuthError,
  orderedRoutes,
  type ProviderEntry,
  redactError,
  redactResponse,
  type ServingConsumer,
  servingCallbacks,
} from '@cortexkit/claustrum-auth-core'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type ChooseAccountResult,
  type LimitSignal,
  type OpenCode2AuthAdapter,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import { noAccountText, servingError } from './messages.ts'

/**
 * The attempt's own value. `accountHeaders` cannot read the vault (it is not
 * given the request, so the origin is unknown there); `rewriteRequest` fills
 * the receipt once the origin has been checked, and the response and the end
 * of the attempt read it back. A response is therefore only ever tied to the
 * receipt that this host was served for that very request.
 */
export interface VaultAttempt {
  receipt?: ClaustrumScopedAttempt
}

export interface VaultAdapterOptions {
  entry: ProviderEntry
  /** The provider id on OpenCode 2, which is also its integration id. */
  provider: string
  consumer: ServingConsumer
  /**
   * Accounts a 429 marked, with the time the mark ends. Shared with the
   * installation's `limit` listener, which writes it.
   */
  rateLimitMarks: Map<string, number>
  now?: () => number
  /** Errors of the 401 report, which never reach the host. */
  onError?: (error: unknown) => void
}

const defaultMarkMs = 60_000

function retryAfterMs(headers: Headers, now: number) {
  const value = headers.get('retry-after')
  if (value === null || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) && date > now ? date - now : undefined
}

/** Until when a limit keeps its account out of routing. */
export function markUntil(limit: LimitSignal, now: number) {
  return now + (limit.retryAfterMs ?? defaultMarkMs)
}

async function rebuild(request: Request, url: URL, headers: Headers) {
  const body =
    request.body === null ? undefined : await request.clone().arrayBuffer()
  return new Request(url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    redirect: request.redirect,
  })
}

/**
 * The OpenCode 2 adapter for one served provider. The installer runs it only
 * for owned transports: requests carrying this provider's placeholder in
 * `Authorization` and nowhere else (`refuseMisplaced` refuses every other
 * carrier before an account is chosen).
 */
export function createVaultAdapter(
  options: VaultAdapterOptions,
): OpenCode2AuthAdapter<never, VaultAttempt, ChooseAccountResult> {
  const now = options.now ?? Date.now
  const placeholder = placeholderSecret(options.provider)
  const serving = {
    entry: options.entry,
    placeholder,
    consumer: options.consumer,
    now,
    rateLimitMarks: options.rateLimitMarks,
  }
  return {
    providerID: options.provider,
    chooseAccount(input) {
      // A provider whose driver never sends its key in Authorization is
      // refused the same way for every account, before any vault read.
      if (options.entry.class === 'C' || options.entry.class === 'D')
        throw servingError(
          new ClaustrumAuthError('placement-refused'),
          options.provider,
          options.entry.origins,
        )
      // Roster order, skipping accounts a 429 marked. A retry never picks the
      // refused account again: returning nothing keeps the host's decision.
      const tried = new Set(
        input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
      )
      const next = orderedRoutes(serving, tried)[0]
      if (next !== undefined || input.phase === 'retry') return next
      // A request with every account marked still goes out on the first one:
      // the host has already waited its own retry delay, and the provider's
      // answer, not a stale mark, decides whether the account is still limited.
      const any = orderedRoutes({ ...serving, rateLimitMarks: undefined })[0]
      if (any !== undefined) return any
      throw new Error(noAccountText(options.provider))
    },
    accountHeaders() {
      return { headers: {}, attempt: {} satisfies VaultAttempt }
    },
    async rewriteRequest({ request, accountId, attempt }) {
      const holder = attempt.data
      // Only the chosen account may serve this attempt, so routing inside the
      // shared callbacks sees that one row and no marks.
      const callbacks = servingCallbacks({
        entry: options.entry,
        placeholder,
        consumer: {
          routingRows: () =>
            options.consumer
              .routingRows()
              .filter((row) => row.id === accountId),
          authorize: (route, signal) =>
            options.consumer.authorize(route, signal),
          send: (...args) => options.consumer.send(...args),
          reportFailure: (...args) => options.consumer.reportFailure(...args),
        },
        now,
      })
      // In order: placement and origin (no vault read), authorize, the
      // class-B account rewrite from the served receipt, then Authorization.
      let served: Awaited<ReturnType<typeof callbacks.request>>
      try {
        served = await callbacks.request(
          new URL(request.url),
          new Headers(request.headers),
          request.signal,
        )
      } catch (error) {
        throw servingError(error, options.provider, options.entry.origins)
      }
      if (!served) return undefined
      if (holder) holder.receipt = served.receipt
      try {
        return await rebuild(request, served.url, served.headers)
      } catch (error) {
        throw redactError(error, [served.receipt.accessToken])
      }
    },
    async rewriteResponse({ response, attempt }) {
      const secret = attempt.data?.receipt?.accessToken
      if (!secret) return undefined
      return redactResponse(response, [secret])
    },
    limitFromResponse({ status, headers }) {
      if (status !== 429) return undefined
      const wait = retryAfterMs(headers, now())
      return {
        reason: 'rate-limit',
        status,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
      }
    },
    async onAttemptEnd(attempt, outcome) {
      // Only the receipt this attempt was served can be reported, never a
      // row of another provider or plugin. Custody drops a kept receipt's
      // 401 without reporting it, since the vault is unreachable then.
      const receipt = attempt.data?.receipt
      if (outcome.status !== 401 || !receipt) return
      try {
        await options.consumer.reportFailure(receipt, 401, 'direct')
      } catch (error) {
        options.onError?.(redactError(error, [receipt.accessToken]))
      }
    },
  }
}
