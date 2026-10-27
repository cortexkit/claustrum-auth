import { command, type ProviderEntry } from '@cortexkit/claustrum-auth-core'

// Every text here is fixed: it names the provider and its allowed origins from
// the plugin's own table, never anything taken from a request or a vault reply.
const refused = 'Request refused locally by the claustrum-auth plugin:'
const nothingSent = 'Nothing was sent.'

export function refusalText(
  code: string,
  provider: string,
  entry: ProviderEntry,
): string {
  switch (code) {
    case 'placement-refused':
      return `${refused} this model's request carries the ${provider} vault placeholder outside the Authorization header, and vault keys are only sent as Authorization: Bearer. ${nothingSent}`
    case 'origin-refused':
      return `${refused} the vault key for ${provider} is only sent to ${entry.origins.join(', ')}, and this request goes elsewhere (check a baseUrl override for this model). ${nothingSent}`
    case 'no-vault-account':
      return `${refused} the Claustrum vault has no usable account for ${provider}. Your own Pi login for ${provider} stays moved aside while the plugin owns it; add an account in the vault, or run ${command} release ${provider}. ${nothingSent}`
    case 'vault-mode-off':
      return `${refused} Pi is not connected to the Claustrum vault, but your Pi login for ${provider} is still moved aside. Reconnect Pi to the vault, or run ${command} release ${provider}. ${nothingSent}`
    case 'vault-unreachable':
      return `${refused} the Claustrum vault could not be reached and no key for ${provider} was read earlier in this session. Start the vault, or run ${command} release ${provider}. ${nothingSent}`
    case 'body-too-large':
      return `${refused} the request body is larger than the 64 MiB the plugin buffers for account failover. ${nothingSent}`
    case 'redirect-limit':
      return `${refused} the provider redirected this request more than five times.`
    case 'account-missing':
    case 'account-path-invalid':
      return `${refused} the vault key for ${provider} names no account the request path can carry. ${nothingSent}`
    case 'vault-refused':
      return `${refused} the Claustrum vault did not serve a key for ${provider}. Check its accounts in the vault, or run ${command} release ${provider}. ${nothingSent}`
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
  return `Your own Pi login for ${provider} (or its absence) is moved aside and restored byte for byte by ${command} release ${provider}. Requests for ${provider} then use keys from the vault.${models}`
}

export const activationRefusals: Record<string, (provider: string) => string> =
  {
    'no-vault-account': (provider) =>
      `The Claustrum vault serves no usable account for ${provider}. Nothing changed.`,
    'vault-mode-off': () =>
      'Pi is not connected to the Claustrum vault. Run the claustrum-auth setup first. Nothing changed.',
    'consent-required': (provider) =>
      `Your Pi login for ${provider} was not moved. Nothing changed.`,
  }

export const unknownProvider = (provider: string) =>
  `The claustrum-auth plugin does not serve "${provider}" on this Pi. It serves: `

// The vault answered, but the plugin could not save its account list for the
// provider, so whether the vault has an account for it is not known yet.
export const unsavedRosterText = (provider: string, cause: string) =>
  `claustrum-auth: the local account list for ${provider} could not be saved (${cause}), so the plugin cannot tell yet whether the vault has an account for ${provider}. Nothing changed; run ${command} use ${provider} again.`

export const usage = `Usage: ${command} use <provider> | ${command} release <provider>`

export const enteredText = (provider: string) =>
  `${provider} now uses keys from the Claustrum vault. Your own login is kept aside until ${command} release ${provider}.`

export const enterFailedText = (provider: string) =>
  `Pi could not move the ${provider} login aside, so ${provider} keeps using it.`

export const enterIncompleteText = (provider: string) =>
  `Moving the ${provider} login aside did not finish. ${provider} refuses requests until ${command} release ${provider} or a restart completes it.`

export const releasedText = (provider: string) =>
  `${provider} is released: your own Pi login is back, and the vault will not take ${provider} over again until ${command} use ${provider}.`

export const releaseKeptText = (provider: string) =>
  `${provider} is released and will not be taken over again until ${command} use ${provider}.`

export const conflictText = (provider: string) =>
  `A Pi login for ${provider} was added while the vault served it. Both that login and your original are kept, and nothing was overwritten; ${provider} stays with the vault until you remove one of them from auth.json and run ${command} release ${provider} again.`

export const missingStashText = (provider: string) =>
  `The saved copy of your ${provider} login is missing, so it cannot be restored. ${provider} keeps refusing requests; log in to ${provider} again with Pi's login command.`

export const exitFailedText = (provider: string) =>
  `Pi could not restore the ${provider} login (another Pi may be holding auth.json). ${provider} stays with the vault; try ${command} release ${provider} again.`
