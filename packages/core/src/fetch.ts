import { randomUUID } from 'node:crypto'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  createRequestHistory,
  decideAfterLimit,
  type LimitCandidate,
  type LimitMark,
  markFromSignal,
  statusVaultOrder,
} from '@cortexkit/common-auth/limits'
import { hasBalanceRule } from './balance.js'
import { type BillingAttempt, observeBillingResponse } from './billing.js'
import { limitFromReply, limitRefusal } from './limits.js'
import {
  ClaustrumAuthError,
  checkOrigin,
  checkPlacement,
  originKey,
  redactError,
  redactResponse,
} from './placement.js'
import { reportRoutedBalance, selectRoutedKey } from './routing.js'
import { placeReceipt, type ServingOptions } from './serving.js'

export const maxBodyBytes = 64 * 1024 * 1024
export type CoreFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
export interface FetchOptions extends ServingOptions {
  host?: 'opencode1' | 'pi'
  fetch: CoreFetch
  // The host supplies its own effective-key resolution, including environment
  // case rules and config precedence. The check is repeated on every request.
  effectiveCredential?: () => boolean | Promise<boolean>
  billing?: (receipt: ClaustrumScopedAttempt) => BillingAttempt | undefined
  routing?: { sessionId: string | undefined; provider: string; modelId: string }
}

async function bufferBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const { value, done } = await reader.read()
      request.signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        throw new ClaustrumAuthError('body-too-large')
      }
      chunks.push(value)
    }
  } finally {
    request.signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export function createFetch(options: FetchOptions): CoreFetch {
  const now = options.now ?? Date.now
  const host = options.host ?? 'opencode1'
  const rateLimitMarks = options.rateLimitMarks ?? new Map<string, number>()
  const localMarks = new Map<string, LimitMark>()
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (
      checkPlacement(url, headers, options.placeholder, options.entry) ===
      'foreign'
    )
      return options.fetch(input, init)
    if (await options.effectiveCredential?.())
      throw new ClaustrumAuthError('credential-shadowed')
    const request = new Request(input, init)
    const signal = request.signal
    signal.throwIfAborted()
    // Read the body before anything else touches it. Under the Fetch standard
    // (Node's undici) `new Request(request, { body: null })` takes the body
    // over instead of dropping it, so no request is derived from this one.
    const body = await bufferBody(request)
    const limits = options.limits ? await options.limits() : undefined
    const template = {
      method: request.method,
      credentials: request.credentials,
      cache: request.cache,
    }
    const tried = new Set<string>()
    let routedAttempt = false
    const rejected = new Set<string>()
    const secrets: string[] = []
    let redirectBilling:
      | { receipt: ClaustrumScopedAttempt; status: number }
      | undefined
    let pending:
      | {
          response: Response
          account: LimitCandidate['account']
          parsed: Awaited<ReturnType<typeof limitFromReply>>
        }
      | undefined
    let history = createRequestHistory({
      requestId: randomUUID(),
      originalUrl: url.href,
      clockNow: now(),
    })
    const candidates = async (): Promise<LimitCandidate[]> => {
      const rows = limits
        ? await limits.candidates()
        : options.consumer.routingRows().map((row) => {
            const until = rateLimitMarks.get(row.id)
            const blockers =
              until !== undefined && until > now()
                ? [
                    {
                      kind: 'hard' as const,
                      until,
                      cause:
                        localMarks.get(row.id)?.until === until
                          ? localMarks.get(row.id)?.cause
                          : undefined,
                    },
                  ]
                : []
            return {
              account: {
                namespace: 'claustrum-auth:standalone',
                accountId: row.id,
                incarnation: 'standalone',
              },
              admitted: true,
              placementEligible: true,
              ready: blockers.length === 0,
              blockers,
            }
          })
      return rows.map((row) => ({
        ...row,
        admitted: row.admitted && !rejected.has(row.account.accountId),
        placementEligible:
          row.placementEligible && !tried.has(row.account.accountId),
      }))
    }
    const decide = (
      phase: 'pre-send' | 'after-limit',
      rows: LimitCandidate[],
      status?: number,
      attempted?: LimitCandidate['account'],
      parsed?: Awaited<ReturnType<typeof limitFromReply>>,
    ) => {
      const next = rows.find(
        (row) => row.admitted && row.ready && row.placementEligible,
      )
      const decision = decideAfterLimit(
        {
          phase,
          host,
          now: now(),
          clockNow: now(),
          sessionId: history.requestId,
          requestScope: { kind: 'pool' },
          history,
          attempted,
          signal: parsed,
          status,
          delivery: { owned: true, attributable: true, replayable: true },
          candidates: rows,
          selection: next
            ? { account: next.account, pin: 'preserve' }
            : undefined,
        },
        statusVaultOrder,
      )
      history = decision.history
      return decision
    }
    try {
      for (;;) {
        signal.throwIfAborted()
        if (routedAttempt && pending && !pending.parsed)
          return await redactResponse(pending.response, secrets)
        const rows = await candidates()
        const ownDecision = pending
          ? decide(
              'after-limit',
              rows,
              pending.response.status,
              pending.account,
              pending.parsed,
            )
          : decide('pre-send', rows)
        if (ownDecision.action === 'pass' && pending)
          return await redactResponse(pending.response, secrets)
        const nextRoute =
          ownDecision.action === 'reroute'
            ? ownDecision.account.accountId
            : rows.find((row) => row.admitted && row.placementEligible)?.account
                .accountId
        let routed = await selectRoutedKey(
          options.consumer,
          options.routing?.provider ?? options.entry.service,
          options.routing?.modelId ?? '',
          options.routing?.sessionId,
          new Set([...tried, ...rejected]),
          nextRoute,
        )
        routedAttempt = routed !== undefined
        const routedId = routed?.routeId
        if (!pending && !rows.some((row) => row.admitted))
          throw new ClaustrumAuthError('no-vault-account')
        // Keep a failed provider response readable until a replacement send
        // is committed, so a vault roster reload cannot turn a retry into a
        // fresh-request refusal instead of returning the provider's response.
        const initial = routed
          ? {
              action: 'reroute' as const,
              account: rows.find((row) => row.account.accountId === routedId)
                ?.account ?? {
                namespace: 'claustrum-auth:routing',
                accountId: routed.routeId,
                incarnation: 'routing',
              },
            }
          : ownDecision
        if (initial.action === 'pass' && pending)
          return await redactResponse(pending.response, secrets)
        if (initial.action === 'refuse') {
          await pending?.response.body?.cancel().catch(() => {})
          return limitRefusal(initial, host, now())
        }
        if (initial.action !== 'reroute')
          throw new Error('claustrum-auth: unsupported limit action')
        let route = initial.account.accountId
        if (!routed && limits && !(await limits.beforeDispatch(route))) {
          rejected.add(route)
          continue
        }
        if (!routed && limits) {
          if (
            !(await candidates()).find((row) => row.account.accountId === route)
              ?.ready
          )
            continue
        }
        await pending?.response.body?.cancel().catch(() => {})
        pending = undefined
        tried.add(route)
        const previousMark = rateLimitMarks.get(route)
        let observation = limits?.observe(route)
        let target = url
        let method = template.method
        let bytes = body
        let response: Response
        let redirects = 0
        for (;;) {
          signal.throwIfAborted()
          checkOrigin(target, options.entry)
          if (redirects > 0 && routed) {
            routed = await selectRoutedKey(
              options.consumer,
              options.routing?.provider ?? options.entry.service,
              options.routing?.modelId ?? '',
              options.routing?.sessionId,
              new Set([...tried].filter((id) => id !== route)),
            )
            if (!routed) throw new ClaustrumAuthError('routing-no-answer')
            route = routed.routeId
            tried.add(route)
            observation = limits?.observe(route)
          }
          const dispatch = async (
            receipt: ClaustrumScopedAttempt,
            dispatchSignal?: AbortSignal,
          ) => {
            secrets.push(receipt.accessToken)
            const draft = placeReceipt(target, headers, options.entry, receipt)
            const dispatchHeaders = new Headers(draft.headers)
            if (!bytes) {
              dispatchHeaders.delete('content-length')
              if (method !== template.method)
                dispatchHeaders.delete('content-type')
            }
            const outbound = new Request(draft.url, {
              method,
              headers: dispatchHeaders,
              body: bytes ? new Uint8Array(bytes) : undefined,
              signal: dispatchSignal ?? signal,
              redirect: 'manual',
              credentials: template.credentials,
              cache: template.cache,
            })
            let billing: BillingAttempt | undefined
            try {
              const reply = await options.fetch(outbound)
              if (
                options.billing &&
                [301, 302, 303, 307, 308].includes(reply.status) &&
                reply.headers.has('location')
              ) {
                // A followed redirect is a routing hop, not a billable model
                // call. Wait until the redirect checks decide to return it.
                redirectBilling = { receipt, status: reply.status }
                return reply
              }
              billing = options.billing?.(receipt)
              return observeBillingResponse(billing, reply)
            } catch (error) {
              const failedBilling = billing ?? options.billing?.(receipt)
              failedBilling?.end(false, false)
              throw error
            }
          }
          if (routed) {
            // Consumer.send can rotate and resend a 401 on its own. Routing
            // owns paid-key admission, so authorize exactly one physical send.
            const receipt = await options.consumer.authorize(route, signal)
            if (receipt.credentialId !== routed.credentialId)
              throw new ClaustrumAuthError('routing-no-answer')
            response = await dispatch(receipt, signal)
            if (response.status === 401)
              await options.consumer.reportFailure(receipt, 401, 'direct')
          } else {
            response = await options.consumer.send(route, dispatch, {
              site: 'claustrum-auth',
              signal,
            })
          }
          signal.throwIfAborted()
          const location = response.headers.get('location')
          if (![301, 302, 303, 307, 308].includes(response.status) || !location)
            break
          const next = new URL(location, target)
          if (originKey(next) !== originKey(target)) break
          // Never turn a provider's echo of a bearer into a URL credential.
          if (
            secrets.some(
              (secret) =>
                next.href.includes(secret) ||
                next.href.includes(encodeURIComponent(secret)),
            )
          )
            break
          checkOrigin(next, options.entry)
          if (redirects++ >= 5) {
            await response.body?.cancel().catch(() => {})
            throw new ClaustrumAuthError('redirect-limit')
          }
          redirectBilling = undefined
          await response.body?.cancel().catch(() => {})
          if (
            (response.status === 303 && method !== 'HEAD') ||
            ([301, 302].includes(response.status) && method === 'POST')
          ) {
            method = 'GET'
            bytes = undefined
          }
          target = next
        }
        if (redirectBilling) {
          const billing = options.billing?.(redirectBilling.receipt)
          redirectBilling = undefined
          response = observeBillingResponse(billing, response)
        }
        const account = observation?.binding.account ?? {
          ...initial.account,
          accountId: route,
        }
        const parsed = await limitFromReply({
          account,
          service: options.entry.service,
          status: response.status,
          headers: response.headers,
          body: () => response.clone().text(),
          now: now(),
        })
        const balance402 = parsed?.kind === 'payment-balance'
        await reportRoutedBalance(
          routed,
          options.routing?.sessionId,
          options.entry.service,
          response.status,
          () => response.clone().text(),
        )
        if (response.ok || (response.status === 402 && !balance402)) {
          if (limits && observation) {
            if (
              hasBalanceRule(options.entry.service) &&
              observation.paymentProbe
            )
              limits.clear(observation, 'payment-balance')
            if (observation.rateProbe) limits.clear(observation, 'rate-limit')
          } else if (
            previousMark !== undefined &&
            previousMark <= now() &&
            rateLimitMarks.get(route) === previousMark
          )
            rateLimitMarks.delete(route)
        }
        signal.throwIfAborted()
        const mark = markFromSignal(parsed, statusVaultOrder.markers[host], {
          now: now(),
        })
        if (mark) {
          if (limits && observation)
            limits.mark(observation, mark, parsed?.observedAt)
          else {
            rateLimitMarks.set(route, mark.until)
            localMarks.set(route, mark)
          }
        }
        pending = {
          response,
          account,
          parsed,
        }
      }
    } catch (error) {
      if (redirectBilling)
        options
          .billing?.(redirectBilling.receipt)
          ?.end(false, false, redirectBilling.status)
      await pending?.response.body?.cancel().catch(() => {})
      throw redactError(error, secrets)
    }
  }
}
