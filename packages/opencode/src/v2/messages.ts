import { ClaustrumAuthError } from '@cortexkit/claustrum-auth-core'
import {
  ClaustrumConsumerError,
  ClaustrumCredentialError,
} from '@cortexkit/common-auth/claustrum'

// Every text the OpenCode 2 entry shows is fixed. None of them interpolates
// request data (URL, header values, vault replies), so a refusal can never
// echo a served secret or the enrollment token. Provider ids and allowed
// origins come from the plugin's own table.

const fix =
  'Sign in again with "Claustrum vault (claustrum-auth plugin)" once the vault serves this provider, or switch this provider back to your own key.'

export function noAccountText(provider: string) {
  return `claustrum-auth plugin: no vault account for ${provider}. Grant one with ck auth, then try again.`
}

export function unreachableText(provider: string) {
  return `claustrum-auth plugin: the Claustrum vault could not be reached, so ${provider} was not sent. Start the vault, or switch ${provider} back to your own key.`
}

export function vaultOffText(provider: string) {
  return `claustrum-auth plugin: vault mode is off on this host, so ${provider} was not sent. Run the claustrum-auth plugin's setup, or switch ${provider} back to your own key.`
}

export function vaultRefusedText(provider: string) {
  return `claustrum-auth plugin: the Claustrum vault did not authorize an account for ${provider}. Check the account with ck auth status. ${fix}`
}

export function placementText(provider: string, header: string) {
  // The installer names the first header that carries the placeholder; when
  // that is Authorization itself, the refusal is that another one does too.
  if (header.toLowerCase() === 'authorization')
    return `claustrum-auth plugin: this request carries the key for ${provider} in more than one header; the claustrum-auth plugin only serves keys sent in Authorization alone.`
  return `claustrum-auth plugin: this model's driver sends its key for ${provider} in ${header}; the claustrum-auth plugin only serves keys sent in Authorization.`
}

export function originText(provider: string, origins: readonly string[]) {
  return `claustrum-auth plugin: the vault key for ${provider} is only sent to ${origins.join(', ')}; this request goes to another origin, so it was not sent.`
}

/** The refusal of an owned WebSocket handshake to an origin not allowed. */
export function handshakeOriginText(
  provider: string,
  origins: readonly string[],
) {
  if (origins.length === 0)
    return `claustrum-auth plugin: the vault key for ${provider} is never sent over WebSocket, so this connection was not opened. Set this provider's transport to http, or switch it back to your own key.`
  return `claustrum-auth plugin: the vault key for ${provider} is only sent over WebSocket to ${origins.join(', ')}; this connection goes to another origin, so it was not opened.`
}

type Refusal = ClaustrumAuthError['code']

function refusalText(
  code: Refusal,
  provider: string,
  origins: readonly string[],
) {
  switch (code) {
    case 'origin-refused':
      return originText(provider, origins)
    case 'placement-refused':
      return placementText(provider, 'a header other than Authorization')
    case 'account-missing':
      return `claustrum-auth plugin: the vault served no account id for ${provider}, which this provider needs in its URL, so the request was not sent.`
    case 'account-path-invalid':
      return `claustrum-auth plugin: the request URL for ${provider} has no account segment the plugin can fill, so it was not sent.`
    case 'no-vault-account':
      return noAccountText(provider)
    case 'vault-mode-off':
      return vaultOffText(provider)
    default:
      return `claustrum-auth plugin: the request for ${provider} was refused (${code}).`
  }
}

/**
 * The plugin's own refusal, also after redaction: `redactError` copies a
 * refusal into a plain `Error` that keeps its `name` and `code`.
 */
function refusalOf(error: unknown): Refusal | undefined {
  if (error instanceof ClaustrumAuthError) return error.code
  if (
    error instanceof Error &&
    error.name === 'ClaustrumAuthError' &&
    typeof (error as { code?: unknown }).code === 'string'
  )
    return (error as unknown as { code: Refusal }).code
  return undefined
}

/**
 * Replaces any error raised while serving an owned request with a fixed text.
 * The original is dropped on purpose: a vault or transport error may carry
 * material this host must never show.
 */
export function servingError(
  error: unknown,
  provider: string,
  origins: readonly string[],
): Error {
  const code = refusalOf(error)
  if (code) {
    const fixed = new ClaustrumAuthError(code)
    fixed.message = refusalText(code, provider, origins)
    return fixed
  }
  if (error instanceof ClaustrumConsumerError) {
    if (error.kind === 'unavailable')
      return new Error(unreachableText(provider))
    if (error.kind === 'not-active') return new Error(vaultOffText(provider))
    if (error.kind === 'route-unavailable' || error.kind === 'route-declined')
      return new Error(noAccountText(provider))
  }
  if (error instanceof ClaustrumCredentialError)
    return new Error(vaultRefusedText(provider))
  if (error instanceof Error && error.name === 'AbortError') return error
  return new Error(
    `claustrum-auth plugin: the request for ${provider} could not be served from the vault.`,
  )
}
