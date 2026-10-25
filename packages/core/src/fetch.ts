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

function retryExpiry(response: Response, now: number) {
  const value = response.headers.get('retry-after')
  if (value !== null) {
    const seconds = Number(value)
    if (value.trim() && Number.isFinite(seconds) && seconds >= 0)
      return now + seconds * 1000
    const date = Date.parse(value)
    if (Number.isFinite(date) && date > now) return date
  }
  return now + 60_000
}

function limited(marks: ReadonlyMap<string, number>, now: number) {
  const expiries = [...marks.values()].filter((expiry) => expiry > now)
  const seconds = Math.max(
    1,
    Math.ceil(
      ((expiries.length ? Math.min(...expiries) : now + 60_000) - now) / 1000,
    ),
  )
  return Response.json(
    { error: 'claustrum-auth: accounts-rate-limited' },
    {
      status: 429,
      headers: { 'retry-after': String(seconds) },
    },
  )
}

export function createFetch(options: FetchOptions): CoreFetch {
  const now = options.now ?? Date.now
  const rateLimitMarks = options.rateLimitMarks ?? new Map<string, number>()
  const routing = { ...options, rateLimitMarks }
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
    const template = new Request(request, { body: null })
    const body = await bufferBody(request)
    const tried = new Set<string>()
    const secrets: string[] = []
    let saw429 = false
    try {
      for (;;) {
        signal.throwIfAborted()
        const route = orderedRoutes(routing, tried)[0]
        if (!route) {
          if (options.consumer.routingRows().length)
            return limited(rateLimitMarks, now())
          throw new ClaustrumAuthError('no-vault-account')
        }
        tried.add(route)
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
        if (response.status !== 429 && response.status !== 401)
          return await redactResponse(response, secrets)
        signal.throwIfAborted()
        if (response.status === 429) {
          saw429 = true
          rateLimitMarks.set(route, retryExpiry(response, now()))
        }
        const next = orderedRoutes(routing, tried)[0]
        if (next) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        if (response.status === 401 && saw429) {
          await response.body?.cancel().catch(() => {})
          return limited(rateLimitMarks, now())
        }
        return await redactResponse(response, secrets)
      }
    } catch (error) {
      throw redactError(error, secrets)
    }
  }
}
