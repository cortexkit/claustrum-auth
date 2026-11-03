import {
  type AccountLimits,
  balanceProbeMs,
  ClaustrumAuthError,
  checkHandshakeOrigin,
  isBalanceFailure,
  isLocalLimitRefusal,
  type LimitObservation,
  limitFromReply,
  limitMarkUntil,
  localLimitRefusal,
  orderedRoutes,
  type ProviderEntry,
  redactError,
  redactResponse,
  type ServingConsumer,
  servingCallbacks,
} from '@cortexkit/claustrum-auth-core'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type LimitSignal as SharedLimitSignal,
  toOpenCode2LimitSignal,
} from '@cortexkit/common-auth/limits'
import {
  type AccountHeadersResult,
  type ChooseAccountResult,
  type EventVerdict,
  type LimitSignal,
  type OpenCode2AuthAdapter,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import { redactCredentialFrame } from '@cortexkit/common-auth/redaction'
import {
  handshakeOriginText,
  noAccountText,
  servingError,
  vaultOffText,
} from './messages.ts'

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
  limits?: AccountLimits
  observation?: LimitObservation
  limit?: SharedLimitSignal
  localRefusal?: boolean
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
 * response, and the provider's error frames. A confirmed balance 402 or a 429
 * limits the account; a 401 is reported like an HTTP 401. The error text handed
 * to the installer is fixed: a frame may echo the served key.
 */
export function inspectResponsesFrame(
  data: string,
  attempt: VaultAttempt | undefined,
  service?: string,
): EventVerdict<never> | undefined {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return { outputStarted: true }
  }
  if (!isRecord(event)) return { outputStarted: true }
  const type =
    typeof event.type === 'string'
      ? event.type
      : event.error != null
        ? 'error'
        : undefined
  // Only known envelopes are safe to replay. response.output_text.done can
  // publish text without a delta; reasoning, tool calls and unfamiliar
  // frames may likewise have already produced host output.
  if (
    type === 'response.created' ||
    type === 'response.in_progress' ||
    type?.startsWith('codex.')
  )
    return undefined
  if (type === 'response.completed' || type === 'response.incomplete')
    return { done: true, outputStarted: true }
  if (type === 'error' || type === 'response.failed') {
    const status = frameStatus(event)
    if (attempt && status !== undefined) attempt.frameStatus = status
    const code = frameCode(event)
    const limited =
      status !== 402 &&
      (status === 429 || (code !== undefined && /rate.?limit/iu.test(code)))
    return {
      error: 'the provider answered with an error frame',
      ...(status === 402 && isBalanceFailure(service, data)
        ? { limit: { reason: 'payment-required', status } }
        : limited
          ? { limit: { reason: 'rate-limit', status: status ?? 429 } }
          : {}),
    }
  }
  return { outputStarted: true }
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
   * Accounts a balance 402 or 429 marked, with the time the mark ends. Shared with the
   * installation's `limit` listener, which writes it.
   */
  rateLimitMarks: Map<string, number>
  limits?: () => Promise<AccountLimits | undefined>
  now?: () => number
  /** Errors of the 401 report, which never reach the host. */
  onError?: (error: unknown) => void
  onRefusal?: (code: 'placement-refused' | 'origin-refused') => void
  /**
   * Shared with the plugin's own WebSocket hooks. Without it, every owned
   * handshake is refused before the vault is read.
   */
  handshakes?: HandshakeState
  /**
   * This host's account mode, read fresh, so a refusal for want of an
   * account can say that vault mode is off instead.
   */
  authority?: () => Promise<'vault' | 'local' | 'unreadable'>
}

const defaultMarkMs = 60_000

/** Until when a limit keeps its account out of routing. */
export function markUntil(limit: LimitSignal, now: number) {
  return (
    now +
    (limit.retryAfterMs ??
      (limit.status === 402 ? balanceProbeMs : defaultMarkMs))
  )
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
    ? ({ transport, data, attempt }) => {
        if (transport !== 'ws') return undefined
        const verdict = inspectResponsesFrame(
          data,
          attempt.data,
          options.entry.service,
        )
        if (verdict?.limit && attempt.data) {
          attempt.data.limit = {
            account: attempt.data.observation?.binding.account ?? {
              namespace: 'claustrum-auth:standalone',
              accountId: attempt.accountId,
              incarnation: 'standalone',
            },
            kind:
              verdict.limit.status === 402 ? 'payment-balance' : 'rate-limit',
            reason: verdict.limit.reason,
            status: verdict.limit.status,
            scope: { kind: 'pool' },
            windows: [],
            observedAt: now(),
          }
        }
        return verdict
      }
    : undefined
  // With vault mode turned off, the hub empties every roster at its next
  // authority read, so "no account" would wrongly tell the user to grant one.
  // Only this refusal path asks for the mode; a served request never does.
  const noAccount = async () => {
    let mode: string | undefined
    try {
      mode = await options.authority?.()
    } catch {}
    return new Error(
      mode === undefined || mode === 'vault'
        ? noAccountText(options.provider)
        : vaultOffText(options.provider),
    )
  }
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
        throw await noAccount()
      }
      // Skip accounts a balance 402 or 429 marked. A retry never picks the
      // refused account again: returning nothing keeps the host's decision.
      const tried = new Set(
        input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
      )
      const limits = await options.limits?.()
      const marks = limits ? await limits.marks() : options.rateLimitMarks
      // The shared statusVaultOrder decision still needs payment-aware terminal
      // history and mark causes. Preserve the existing selection until it can
      // represent the same balance and mixed-429 outcomes as the core fetch.
      const next = routes(consumer, tried, marks)[0]
      if (next !== undefined || input.phase === 'retry') return next
      // A request with every account marked still goes out on the first one:
      // the host has already waited its own retry delay, and the provider's
      // answer, not a stale mark, decides whether the account is still limited.
      const any = routes(consumer, new Set(), undefined)[0]
      if (any !== undefined) return any
      throw await noAccount()
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
      const limits = await options.limits?.()
      if (limits && !(await limits.beforeDispatch(accountId)))
        throw await noAccount()
      const observation = limits?.observe(accountId)
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
          limits,
          observation,
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
        limits: options.limits,
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
        holder.limits = served.limits
        holder.observation = served.observation
      }
      try {
        return await rebuild(request, served.url, served.headers)
      } catch (error) {
        throw redactError(error, [served.receipt.accessToken])
      }
    },
    answeredBy({ response, attempt }) {
      // The installer wraps response streams before rewriteResponse. Capture
      // our in-memory refusal identity first; provider text cannot forge it.
      if (attempt.data && isLocalLimitRefusal(response))
        attempt.data.localRefusal = true
      return undefined
    },
    async rewriteResponse({ response, attempt }) {
      const secret = attempt.data?.receipt?.accessToken
      if (!secret) return undefined
      const rewritten = await redactResponse(response, [secret])
      return isLocalLimitRefusal(response)
        ? localLimitRefusal(rewritten)
        : rewritten
    },
    responseRetry({ response, attempt }) {
      return attempt.data?.localRefusal || isLocalLimitRefusal(response)
        ? 'veto'
        : undefined
    },
    async limitFromResponse({ status, headers, body, attempt }) {
      if (attempt.data?.localRefusal) return undefined
      const parsed = await limitFromReply({
        account: attempt.data?.observation?.binding.account ?? {
          namespace: 'claustrum-auth:standalone',
          accountId: attempt.accountId,
          incarnation: 'standalone',
        },
        service: options.entry.service,
        status,
        headers,
        body,
        now: now(),
      })
      if (parsed && attempt.data) attempt.data.limit = parsed
      return parsed ? toOpenCode2LimitSignal(parsed) : undefined
    },
    // Frames of an owned socket; HTTP streams keep the installer's default
    // (nothing read from their events), as before WebSocket was served.
    ...(inspectEvent ? { inspectEvent } : {}),
    async onAttemptEnd(attempt, outcome) {
      const data = attempt.data
      const parsed = data?.limit
      if (parsed && data?.limits && data.observation) {
        const until = limitMarkUntil(parsed, 'opencode2', now())
        if (until !== undefined) data.limits.mark(data.observation, until)
      }
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
