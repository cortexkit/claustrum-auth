import { limitFromReply, limitMarkUntil, localLimitRefusal } from './limits.js'
import {
  ClaustrumAuthError,
  checkOrigin,
  checkPlacement,
  originKey,
  redactError,
  redactResponse,
} from './placement.js'
import { orderedRoutes, placeReceipt, type ServingOptions } from './serving.js'

export const maxBodyBytes = 64 * 1024 * 1024
export type CoreFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
export interface FetchOptions extends ServingOptions {
  fetch: CoreFetch
  // The host supplies its own effective-key resolution, including environment
  // case rules and config precedence. The check is repeated on every request.
  effectiveCredential?: () => boolean | Promise<boolean>
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

function limited(marks: ReadonlyMap<string, number>, now: number) {
  const expiries = [...marks.values()].filter(
    (expiry) => Number.isFinite(expiry) && expiry > now,
  )
  const seconds = Math.max(
    1,
    Math.ceil(
      ((expiries.length ? Math.min(...expiries) : now + 60_000) - now) / 1000,
    ),
  )
  return localLimitRefusal(
    Response.json(
      { error: 'claustrum-auth: accounts-rate-limited' },
      {
        status: 429,
        headers: { 'retry-after': String(seconds) },
      },
    ),
  )
}

export function createFetch(options: FetchOptions): CoreFetch {
  const now = options.now ?? Date.now
  const rateLimitMarks = options.rateLimitMarks ?? new Map<string, number>()
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
    let marks = limits ? await limits.marks() : rateLimitMarks
    const routing = { ...options, rateLimitMarks: marks }
    const template = {
      method: request.method,
      credentials: request.credentials,
      cache: request.cache,
    }
    const tried = new Set<string>()
    const secrets: string[] = []
    let saw429 = false
    let saw402 = false
    try {
      for (;;) {
        signal.throwIfAborted()
        if (limits) marks = routing.rateLimitMarks = await limits.marks()
        const route = orderedRoutes(routing, tried)[0]
        if (!route) {
          if (options.consumer.routingRows().length)
            return limited(marks, now())
          throw new ClaustrumAuthError('no-vault-account')
        }
        if (limits && !(await limits.beforeDispatch(route))) {
          tried.add(route)
          continue
        }
        if (limits) {
          routing.rateLimitMarks = marks = await limits.marks()
          if ((marks.get(route) ?? 0) > now()) continue
        }
        tried.add(route)
        const previousMark = marks.get(route)
        const observation = limits?.observe(route)
        let target = url
        let method = template.method
        let bytes = body
        let response: Response
        let redirects = 0
        for (;;) {
          signal.throwIfAborted()
          checkOrigin(target, options.entry)
          response = await options.consumer.send(
            route,
            async (receipt, dispatchSignal) => {
              secrets.push(receipt.accessToken)
              const draft = placeReceipt(
                target,
                headers,
                options.entry,
                receipt,
              )
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
              return options.fetch(outbound)
            },
            { site: 'claustrum-auth', signal },
          )
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
        const parsed = await limitFromReply({
          account: observation?.binding.account ?? {
            namespace: 'claustrum-auth:standalone',
            accountId: route,
            incarnation: 'standalone',
          },
          service: options.entry.service,
          status: response.status,
          headers: response.headers,
          body: () => response.clone().text(),
          now: now(),
        })
        const balance402 = parsed?.kind === 'payment-balance'
        if (
          (response.ok || (response.status === 402 && !balance402)) &&
          (previousMark !== undefined || observation?.hadMark) &&
          (previousMark === undefined || previousMark <= now())
        ) {
          if (limits && observation) limits.clear(observation)
          else if (rateLimitMarks.get(route) === previousMark)
            rateLimitMarks.delete(route)
        }
        // statusVaultOrder does not yet combine payment and 429 history or
        // retain a payment cause on persisted marks. Keep the existing terminal
        // decision until those shared contracts can reproduce balance failover.
        if (response.status !== 401 && response.status !== 429 && !balance402)
          return await redactResponse(response, secrets)
        signal.throwIfAborted()
        if (response.status === 429 || balance402) {
          if (response.status === 429) saw429 = true
          else saw402 = true
          if (parsed) {
            const until = limitMarkUntil(parsed, 'opencode1', now())
            if (until !== undefined) {
              if (limits && observation) {
                limits.mark(observation, until)
                routing.rateLimitMarks = marks = await limits.marks()
              } else rateLimitMarks.set(route, until)
            }
          }
        }
        const next = orderedRoutes(routing, tried)[0]
        if (next) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        if (saw429 && (response.status === 401 || saw402)) {
          await response.body?.cancel().catch(() => {})
          return limited(marks, now())
        }
        return await redactResponse(response, secrets)
      }
    } catch (error) {
      throw redactError(error, secrets)
    }
  }
}
