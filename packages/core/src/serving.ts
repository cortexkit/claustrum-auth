import type {
  ClaustrumConsumer,
  ClaustrumScopedAttempt,
} from '@cortexkit/common-auth/claustrum'
import { routeOrdered } from '@cortexkit/common-auth/routing'
import {
  ClaustrumAuthError,
  checkPlacement,
  redactError,
  redactResponse,
  rewriteAccount,
} from './placement.js'
import type { ProviderEntry } from './providers.js'

export type ServingConsumer = Pick<
  ClaustrumConsumer,
  'routingRows' | 'authorize' | 'send' | 'reportFailure'
>
export interface ServingOptions {
  entry: ProviderEntry
  placeholder: string
  consumer: ServingConsumer
  now?: () => number
  rateLimitMarks?: Map<string, number>
}

// Pass these provider rows to routing as api-key without quota data, even when
// their credentials are OAuth. Custody still checks OAuth expiry.
export function orderedRoutes(
  options: ServingOptions,
  tried: ReadonlySet<string> = new Set(),
) {
  return routeOrdered({
    rows: options.consumer
      .routingRows()
      .map((row) => ({ id: row.id, kind: 'api-key' as const })),
    now: (options.now ?? Date.now)(),
    rateLimitMarks: options.rateLimitMarks,
  }).order.filter((id) => !tried.has(id))
}

export function placeReceipt(
  url: URL,
  headers: Headers,
  entry: ProviderEntry,
  receipt: ClaustrumScopedAttempt,
) {
  const target = rewriteAccount(url, entry, receipt.assertedAccountIdentity)
  const edited = new Headers(headers)
  edited.set('authorization', `Bearer ${receipt.accessToken}`)
  return { url: target, headers: edited }
}

// Host-independent callbacks for the OpenCode 2 adapter. The returned holder
// retains the issuing receipt, so a response cannot be attributed to a row
// merely because it shares a provider or session with an owned request.
export function servingCallbacks(options: ServingOptions) {
  return {
    async request(url: URL, headers: Headers, signal?: AbortSignal) {
      if (
        checkPlacement(url, headers, options.placeholder, options.entry) ===
        'foreign'
      )
        return undefined
      const route = orderedRoutes(options)[0]
      if (!route) throw new ClaustrumAuthError('no-vault-account')
      const receipt = await options.consumer.authorize(route, signal)
      try {
        const draft = placeReceipt(url, headers, options.entry, receipt)
        return { ...draft, receipt, route }
      } catch (error) {
        throw redactError(error, [receipt.accessToken])
      }
    },
    async response(
      holder: { receipt: ClaustrumScopedAttempt; route: string } | undefined,
      response: Response,
    ) {
      if (!holder) return response
      const secret = holder.receipt.accessToken
      try {
        if (response.status === 401)
          await options.consumer.reportFailure(holder.receipt, 401, 'direct')
        return await redactResponse(response, [secret])
      } catch (error) {
        throw redactError(error, [secret])
      }
    },
  }
}
