import {
  ClaustrumAuthError,
  checkHandshakeOrigin,
  orderedRoutes,
  type ProviderEntry,
  redactError,
  redactResponse,
  type ServingConsumer,
  servingCallbacks,
} from '@cortexkit/claustrum-auth-core'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type AccountHeadersResult,
  type ChooseAccountResult,
  type EventVerdict,
  type LimitSignal,
  type OpenCode2AuthAdapter,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import { redactCredentialFrame } from '@cortexkit/common-auth/redaction'
import { handshakeOriginText, noAccountText, servingError } from './messages.ts'

/**
 * The attempt's own value. On HTTP, `accountHeaders` cannot read the vault
 * (it is not given the request, so the origin is unknown there);
 * `rewriteRequest` fills the receipt once the origin has been checked. On a
 * WebSocket handshake, `accountHeaders` reads it, but only for a handshake
 * whose origin the plugin's own handshake hook has already checked
 * (`HandshakeState`). The response, the frames and the end of the attempt
 * read it back, so a response is only ever tied to the receipt that this host
 * was served for that very request.
 */
export interface VaultAttempt {
  receipt?: ClaustrumScopedAttempt
  /** The member that issued `receipt`, the only one that may report it. */
  consumer?: ServingConsumer
  /** The handshake URL whose origin was checked before `receipt` was read. */
  handshakeURL?: string
  /** A provider status an error frame of this attempt carried. */
  frameStatus?: number
}

/** Identifies a session's socket: the host keeps one per session and kind. */
export const socketKey = (sessionID: string, kind: string) =>
  `${sessionID}\u0000${kind}`

/**
 * What the plugin's own WebSocket hooks share with the adapter of one
 * provider. The host runs every handshake hook of a provider in registration
 * order, so the plugin's handshake hook (registered before the installer)
 * checks the origin and leaves the URL here, and `accountHeaders`, which the
 * installer calls next for the same handshake, reads the vault only when it
 * finds one.
 */
export interface HandshakeState {
  /** Owned handshakes whose origin passed, by `socketKey`. */
  readonly pending: Map<string, string>
  /** Secrets served into each socket's handshakes, newest last. */
  readonly served: Map<string, string[]>
}

export function createHandshakeState(): HandshakeState {
  return { pending: new Map(), served: new Map() }
}

// Bounds for the redaction memory: a few handshakes per socket, and the
// sockets of a few hundred sessions.
const servedPerSocket = 4
const servedSockets = 256

function rememberServed(state: HandshakeState, key: string, secret: string) {
  const secrets = (state.served.get(key) ?? []).filter((s) => s !== secret)
  secrets.push(secret)
  state.served.delete(key)
  state.served.set(key, secrets.slice(-servedPerSocket))
  while (state.served.size > servedSockets) {
    const oldest = state.served.keys().next().value
    if (oldest === undefined) break
    state.served.delete(oldest)
  }
}

/** Removes every secret served into this socket from one received frame. */
export function redactFrame(state: HandshakeState, key: string, frame: string) {
  let result = frame
  for (const secret of state.served.get(key) ?? [])
    result = redactCredentialFrame(result, secret)
  return result
}

/**
 * The plugin's own handshake check, run before the installer's: a handshake
 * that carries this provider's placeholder anywhere must go to one of the
 * entry's handshake origins, or it is refused here, before any account is
 * chosen or the vault read. Returns the refusal to throw, or undefined.
 */
export function checkOwnedHandshake(
  state: HandshakeState,
  entry: ProviderEntry,
  provider: string,
  draft: {
    sessionID: string
    kind: string
    url: string
    headers: Record<string, string>
  },
): Error | undefined {
  const key = socketKey(draft.sessionID, draft.kind)
  state.pending.delete(key)
  const placeholder = placeholderSecret(provider)
  if (
    !Object.values(draft.headers).some((value) => value.includes(placeholder))
  )
    return undefined
  try {
    checkHandshakeOrigin(new URL(draft.url), entry)
  } catch {
    return handshakeRefusal(entry, provider)
  }
  state.pending.set(key, draft.url)
  return undefined
}

function handshakeRefusal(entry: ProviderEntry, provider: string) {
  const error = new ClaustrumAuthError('origin-refused')
  error.message = handshakeOriginText(provider, entry.handshakeOrigins ?? [])
  return error
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function frameStatus(event: Record<string, unknown>) {
  for (const value of [
    event.status,
    event.status_code,
    isRecord(event.error) ? event.error.status : undefined,
    isRecord(event.response) && isRecord(event.response.error)
      ? event.response.error.status
      : undefined,
  ])
    if (typeof value === 'number') return value
  return undefined
}

function frameCode(event: Record<string, unknown>) {
  const nested = isRecord(event.error)
    ? event.error
    : isRecord(event.response) && isRecord(event.response.error)
      ? event.response.error
      : undefined
  const code = event.code ?? nested?.code ?? nested?.type
  return typeof code === 'string' ? code : undefined
}

/**
 * Reads one Responses frame of an owned socket: output, the end of the
 * response, and the provider's error frames, whose 429 is a limit on the
 * account and whose 401 is reported like an HTTP 401. The error text handed
 * to the installer is fixed: a frame may echo the served key.
 */
export function inspectResponsesFrame(
  data: string,
  attempt: VaultAttempt | undefined,
): EventVerdict<never> | undefined {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(event)) return undefined
  const type =
    typeof event.type === 'string'
      ? event.type
      : event.error != null
        ? 'error'
        : undefined
  if (type === undefined) return undefined
  if (type === 'response.completed' || type === 'response.incomplete')
    return { done: true }
  if (type === 'error' || type === 'response.failed') {
    const status = frameStatus(event)
    if (attempt && status !== undefined) attempt.frameStatus = status
    const code = frameCode(event)
    const limited =
      status === 429 || (code !== undefined && /rate.?limit/iu.test(code))
    return {
      error: 'the provider answered with an error frame',
      ...(limited
        ? { limit: { reason: 'rate-limit', status: status ?? 429 } }
        : {}),
    }
  }
  if (type.startsWith('response.') && type.endsWith('.delta'))
    return { outputStarted: true }
  return undefined
}

export interface VaultAdapterOptions {
  entry: ProviderEntry
  /** The provider id on OpenCode 2, which is also its integration id. */
  provider: string
  /**
   * The provider's hub member, once the hub is built; undefined when the
   * host's catalog does not hold the provider.
   */
  consumer: () => Promise<ServingConsumer | undefined>
  /**
   * Accounts a 429 marked, with the time the mark ends. Shared with the
   * installation's `limit` listener, which writes it.
   */
  rateLimitMarks: Map<string, number>
  now?: () => number
  /** Errors of the 401 report, which never reach the host. */
  onError?: (error: unknown) => void
  onRefusal?: (code: 'placement-refused' | 'origin-refused') => void
  /**
   * Shared with the plugin's own WebSocket hooks. Without it, every owned
   * handshake is refused before the vault is read.
   */
  handshakes?: HandshakeState
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
  const refuse = (error: unknown) => {
    if (
      error instanceof ClaustrumAuthError &&
      (error.code === 'placement-refused' || error.code === 'origin-refused')
    )
      options.onRefusal?.(error.code)
    return servingError(error, options.provider, options.entry.origins)
  }
  const routes = (
    consumer: ServingConsumer,
    tried: ReadonlySet<string>,
    marks: Map<string, number> | undefined,
  ) =>
    orderedRoutes(
      {
        entry: options.entry,
        placeholder,
        consumer,
        now,
        rateLimitMarks: marks,
      },
      tried,
    )
  type Adapter = OpenCode2AuthAdapter<never, VaultAttempt, ChooseAccountResult>
  const inspectEvent: Adapter['inspectEvent'] = options.entry.handshakeOrigins
    ?.length
    ? ({ transport, data, attempt }) =>
        transport === 'ws'
          ? inspectResponsesFrame(data, attempt.data)
          : undefined
    : undefined
  return {
    providerID: options.provider,
    async chooseAccount(input) {
      // A provider whose driver never sends its key in Authorization is
      // refused the same way for every account, before any vault read.
      if (options.entry.class === 'C' || options.entry.class === 'D')
        throw refuse(new ClaustrumAuthError('placement-refused'))
      const consumer = await options.consumer()
      if (!consumer) {
        if (input.phase === 'retry') return undefined
        throw new Error(noAccountText(options.provider))
      }
      // Roster order, skipping accounts a 429 marked. A retry never picks the
      // refused account again: returning nothing keeps the host's decision.
      const tried = new Set(
        input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
      )
      const next = routes(consumer, tried, options.rateLimitMarks)[0]
      if (next !== undefined || input.phase === 'retry') return next
      // A request with every account marked still goes out on the first one:
      // the host has already waited its own retry delay, and the provider's
      // answer, not a stale mark, decides whether the account is still limited.
      const any = routes(consumer, new Set(), undefined)[0]
      if (any !== undefined) return any
      throw new Error(noAccountText(options.provider))
    },
    async accountHeaders({
      sessionID,
      kind,
      accountId,
    }): Promise<AccountHeadersResult<VaultAttempt>> {
      // HTTP: the vault is read in `rewriteRequest`, after the origin check.
      // A handshake gives the adapter no async step after its URL is known,
      // so the plugin's handshake hook checked the origin before this call
      // and left the URL here; only then is the vault read now.
      const key = socketKey(sessionID, kind)
      const url = options.handshakes?.pending.get(key)
      if (url === undefined)
        return { headers: {}, attempt: {} satisfies VaultAttempt }
      options.handshakes?.pending.delete(key)
      // The handshake URL has no account segment the plugin could fill.
      if (options.entry.class !== 'A')
        throw refuse(new ClaustrumAuthError('placement-refused'))
      const consumer = await options.consumer()
      if (!consumer) throw new Error(noAccountText(options.provider))
      let receipt: ClaustrumScopedAttempt
      try {
        receipt = await consumer.authorize(accountId)
      } catch (error) {
        throw refuse(error)
      }
      if (options.handshakes)
        rememberServed(options.handshakes, key, receipt.accessToken)
      return {
        headers: { authorization: `Bearer ${receipt.accessToken}` },
        attempt: {
          receipt,
          consumer,
          handshakeURL: url,
        } satisfies VaultAttempt,
      }
    },
    rewriteHandshakeURL({ url, attempt }) {
      // Runs before the account headers enter the handshake. The URL must be
      // the one whose origin was checked before the vault was read; anything
      // else (no check ran, or a hook in between moved the URL) is refused,
      // so the served key is never written into this handshake.
      const data = attempt.data
      let allowed = data?.receipt !== undefined && data.handshakeURL === url
      if (allowed) {
        try {
          checkHandshakeOrigin(new URL(url), options.entry)
        } catch {
          allowed = false
        }
      }
      if (!allowed) {
        options.onRefusal?.('origin-refused')
        throw handshakeRefusal(options.entry, options.provider)
      }
      return undefined
    },
    async rewriteRequest({ request, accountId, attempt }) {
      const holder = attempt.data
      const consumer = await options.consumer()
      if (!consumer) throw new Error(noAccountText(options.provider))
      // Only the chosen account may serve this attempt, so routing inside the
      // shared callbacks sees that one row and no marks.
      const callbacks = servingCallbacks({
        entry: options.entry,
        placeholder,
        consumer: {
          routingRows: () =>
            consumer.routingRows().filter((row) => row.id === accountId),
          authorize: (route, signal) => consumer.authorize(route, signal),
          send: (...args) => consumer.send(...args),
          reportFailure: (...args) => consumer.reportFailure(...args),
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
        throw refuse(error)
      }
      if (!served) return undefined
      if (holder) {
        holder.receipt = served.receipt
        holder.consumer = consumer
      }
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
    // Frames of an owned socket; HTTP streams keep the installer's default
    // (nothing read from their events), as before WebSocket was served.
    ...(inspectEvent ? { inspectEvent } : {}),
    async onAttemptEnd(attempt, outcome) {
      // Only the receipt this attempt was served can be reported, never a
      // row of another provider or plugin. Custody drops a kept receipt's
      // 401 without reporting it, since the vault is unreachable then. On a
      // socket the 401 arrives in an error frame, not as a status.
      const receipt = attempt.data?.receipt
      const consumer = attempt.data?.consumer
      const status = outcome.status ?? attempt.data?.frameStatus
      if (status !== 401 || !receipt || !consumer) return
      try {
        await consumer.reportFailure(receipt, 401, 'direct')
      } catch (error) {
        options.onError?.(redactError(error, [receipt.accessToken]))
      }
    },
  }
}
