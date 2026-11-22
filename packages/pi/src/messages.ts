import {
  command,
  type ProviderEntry,
  routingRefusalText,
} from '@cortexkit/claustrum-auth-core'

// Every text here is fixed: it names the provider and its allowed origins from
// the plugin's own table, never anything taken from a request or a vault reply.
const refused = 'Request refused locally by the claustrum-auth plugin:'
const nothingSent = 'Nothing was sent.'
const releaseAndSignIn = (provider: string) =>
  `run ${command} release ${provider} and sign in to ${provider} again in Pi`

export function refusalText(
  code: string,
  provider: string,
  entry: ProviderEntry,
): string {
  const routing = routingRefusalText(code)
  if (routing) return routing
  switch (code) {
    case 'placement-refused':
      return `${refused} this model's request carries the ${provider} vault placeholder outside the Authorization header, and vault keys are only sent as Authorization: Bearer. ${nothingSent}`
    case 'origin-refused':
      return `${refused} the vault key for ${provider} is only sent to ${entry.origins.join(', ')}, and this request goes elsewhere (check a baseUrl override for this model). ${nothingSent}`
    case 'no-vault-account':
      return `${refused} the Claustrum vault has no usable account for ${provider}. Add an account in the vault, or ${releaseAndSignIn(provider)}. ${nothingSent}`
    case 'route-gone':
      return `${refused} the Claustrum vault no longer serves this account for ${provider}; it was disabled, removed or changed after the plugin read it. Check the vault's accounts and run ${command} use ${provider} again to pick them up, or ${releaseAndSignIn(provider)}. ${nothingSent}`
    case 'vault-mode-off':
      return `${refused} Pi is not connected to the Claustrum vault, but the vault placeholder for ${provider} is still set. Reconnect Pi to the vault, or ${releaseAndSignIn(provider)}. ${nothingSent}`
    case 'vault-unreachable':
      return `${refused} the Claustrum vault could not be reached and no key for ${provider} was read earlier in this session. Start the vault, or ${releaseAndSignIn(provider)}. ${nothingSent}`
    case 'body-too-large':
      return `${refused} the request body is larger than the 64 MiB the plugin buffers for account failover. ${nothingSent}`
    case 'redirect-limit':
      return `${refused} the provider redirected this request more than five times.`
    case 'account-missing':
    case 'account-path-invalid':
      return `${refused} the vault key for ${provider} names no account the request path can carry. ${nothingSent}`
    case 'vault-refused':
      return `${refused} the Claustrum vault did not serve a key for ${provider}. Check its accounts in the vault, or ${releaseAndSignIn(provider)}. ${nothingSent}`
    default:
      return `${refused} the Claustrum vault did not serve a key for ${provider} (${code}). ${nothingSent}`
  }
}

export const consentTitle = (provider: string) =>
  `Let the Claustrum vault serve ${provider}?`

export function consentText(provider: string, hidden: number): string {
  const models =
    hidden > 0
      ? ` While it does, ${hidden} ${provider} model${hidden === 1 ? '' : 's'} that send their key outside the Authorization header ${hidden === 1 ? 'is' : 'are'} hidden.`
      : ''
  return `Connecting deletes your existing Pi login for ${provider}, if any. Requests for ${provider} then use keys from the vault. Sign in to ${provider} again in Pi after running ${command} release ${provider}.${models}`
}

export const activationRefusals: Record<string, (provider: string) => string> =
  {
    'no-vault-account': (provider) =>
      `The Claustrum vault serves no usable account for ${provider}. Nothing changed.`,
    'vault-mode-off': () =>
      'Pi is not connected to the Claustrum vault. Run the claustrum-auth setup first. Nothing changed.',
    'consent-required': (provider) =>
      `Your Pi login for ${provider} was not removed. Nothing changed.`,
  }

export const unknownProvider = (provider: string) =>
  `The claustrum-auth plugin does not serve "${provider}" on this Pi. It serves: `

// The vault answered, but the plugin could not save its account list for the
// provider, so whether the vault has an account for it is not known yet.
export const unsavedRosterText = (provider: string, cause: string) =>
  `claustrum-auth: the local account list for ${provider} could not be saved (${cause}), so the plugin cannot tell yet whether the vault has an account for ${provider}. Nothing changed; run ${command} use ${provider} again.`

export const usage = `Usage: ${command} use <provider> | ${command} release <provider>`

export const enteredText = (provider: string) =>
  `${provider} now uses keys from the Claustrum vault. To use your own login, ${releaseAndSignIn(provider)}.`

export const enterFailedText = (provider: string) =>
  `Pi could not replace the ${provider} login. The vault did not take over.`

export const enterIncompleteText = (provider: string) =>
  `Pi could not finish connecting ${provider} to the vault. Run ${command} release ${provider} to clear the placeholder before trying again.`

export const releasedText = (provider: string) =>
  `${provider} is released. Sign in to ${provider} again in Pi. The vault will not take ${provider} over again until ${command} use ${provider}.`

export const releaseKeptText = (provider: string) =>
  `${provider} is released and will not be taken over again until ${command} use ${provider}.`

export const releaseNoPlaceholderText = (provider: string) =>
  `${releaseKeptText(provider)} No vault placeholder was present, so the Pi slot was left unchanged. Sign in with Pi again if needed.`

export const exitFailedText = (provider: string) =>
  `Pi could not clear the vault placeholder for ${provider} (another Pi may be holding auth.json). Try ${command} release ${provider} again before signing in to Pi.`
