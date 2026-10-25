import {
  redactCredentialError,
  redactCredentialResponse,
  redactCredentialText,
} from '@cortexkit/common-auth/redaction'
import type { ProviderEntry } from './providers.js'

export type Refusal =
  | 'placement-refused'
  | 'origin-refused'
  | 'account-missing'
  | 'account-path-invalid'
  | 'credential-shadowed'
  | 'body-too-large'
  | 'redirect-limit'
  | 'no-vault-account'
  | 'vault-mode-off'
  | 'consent-required'

export class ClaustrumAuthError extends Error {
  constructor(readonly code: Refusal) {
    super(`claustrum-auth: ${code}`)
    this.name = 'ClaustrumAuthError'
  }
}

export function placement(
  url: URL,
  headers: Headers,
  placeholder: string,
): 'foreign' | 'bearer' {
  let carriers = 0
  for (const [, value] of headers) {
    if (value.includes(placeholder)) carriers++
  }
  for (const [name, value] of url.searchParams) {
    if (name.includes(placeholder) || value.includes(placeholder)) carriers++
  }
  if (carriers === 0) return 'foreign'
  if (
    carriers !== 1 ||
    headers.get('authorization') !== `Bearer ${placeholder}`
  )
    throw new ClaustrumAuthError('placement-refused')
  return 'bearer'
}

// Compare the normalized scheme, host and port for HTTP and handshakes alike.
// URL canonicalizes an explicit default port before the comparison.
export function originKey(url: URL): string {
  return `${url.protocol}${url.host}`
}

export function checkOrigin(url: URL, entry: ProviderEntry): void {
  if (
    url.username ||
    url.password ||
    !entry.origins.some(
      (origin) => originKey(new URL(origin)) === originKey(url),
    )
  )
    throw new ClaustrumAuthError('origin-refused')
}

export function checkPlacement(
  url: URL,
  headers: Headers,
  placeholder: string,
  entry: ProviderEntry,
): 'foreign' | 'bearer' {
  const owned = placement(url, headers, placeholder)
  if (owned === 'foreign') return owned
  if (entry.class === 'C' || entry.class === 'D')
    throw new ClaustrumAuthError('placement-refused')
  checkOrigin(url, entry)
  return owned
}

export function rewriteAccount(
  url: URL,
  entry: ProviderEntry,
  account: string | undefined,
): URL {
  if (entry.class !== 'B') return url
  if (!account) throw new ClaustrumAuthError('account-missing')
  if (account === '.' || account === '..')
    throw new ClaustrumAuthError('account-path-invalid')
  const result = new URL(url)
  const segments = result.pathname.split('/')
  const prefix = entry.accountPath
  if (
    !prefix ||
    prefix.some((segment, index) => segments[index + 1] !== segment)
  )
    throw new ClaustrumAuthError('account-path-invalid')
  const index = prefix.length + 1
  if (!segments[index]) throw new ClaustrumAuthError('account-path-invalid')
  // Encode an asserted identity as one path segment, never as URL syntax.
  segments[index] = encodeURIComponent(account)
  result.pathname = segments.join('/')
  return result
}

export async function redactResponse(
  response: Response,
  secrets: readonly string[],
) {
  let result = response
  for (const secret of secrets) {
    result = await redactCredentialResponse(result, secret, 'event-stream')
  }
  const headers = new Headers(result.headers)
  for (const [name, value] of headers) {
    let redacted = value
    for (const secret of secrets)
      redacted = redactCredentialText(redacted, secret)
    headers.set(name, redacted)
  }
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  })
}

export function redactError(error: unknown, secrets: readonly string[]) {
  let result = redactCredentialError(error)
  for (const secret of secrets) result = redactCredentialError(result, secret)
  return result
}
