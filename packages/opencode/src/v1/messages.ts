import { command } from '@cortexkit/claustrum-auth-core'
import type { EffectiveCredential } from './effective.js'

// Removal commands for the platform the host runs on. The plugin cannot tell
// which shell started OpenCode, so Windows gets both PowerShell and cmd forms.
export function removeVariableHelp(
  variable: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32')
    return [
      `PowerShell: Remove-Item Env:${variable}  (for good: [Environment]::SetEnvironmentVariable('${variable}', $null, 'User'))`,
      `cmd: set ${variable}=  (for good: remove it under System Properties, Environment Variables)`,
    ].join('\n')
  return `sh: unset ${variable}  (for good: delete it from the shell profile that sets it)`
}

export function shadowedMessage(
  provider: string,
  variable: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    `claustrum-auth: your key in ${variable} is shadowed by the vault placeholder stored for ${provider}; run ${command} release ${provider} to use your key, or remove ${variable} from your environment to use the vault.`,
    removeVariableHelp(variable, platform),
  ].join('\n')
}

export function userCredentialMessage(
  provider: string,
  credential: EffectiveCredential,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (credential.source) {
    case 'stored':
      return `claustrum-auth: ${provider} uses your own stored key; the vault key is not used until you remove it (opencode auth logout ${provider}), then run ${command} use ${provider} again.`
    case 'config':
      return `claustrum-auth: ${provider} uses the apiKey set in your OpenCode config (provider.${provider}.options.apiKey); the vault key is not used until you remove it, then run ${command} use ${provider} again.`
    case 'env':
      return [
        `claustrum-auth: ${provider} uses your own key (${credential.variable}); the vault key is not used until you remove it from your environment, then run ${command} use ${provider} again.`,
        removeVariableHelp(credential.variable, platform),
      ].join('\n')
  }
}

// Fixed text for each local refusal. Nothing here interpolates request data,
// so a message can never echo a header, URL or served secret.
export function refusalMessage(code: string, provider: string): string {
  switch (code) {
    case 'placement-refused':
      return `claustrum-auth: this model's driver sends its key for ${provider} outside the Authorization header; the claustrum-auth plugin only serves keys sent in Authorization.`
    case 'origin-refused':
      return `claustrum-auth: the vault key for ${provider} is only sent to the provider's own origins; this request goes elsewhere (check provider.${provider}.options.baseURL).`
    case 'no-vault-account':
      return `claustrum-auth: no vault account for ${provider}.`
    case 'vault-unreachable':
      return `claustrum-auth: the vault could not be reached and no earlier key for ${provider} is kept in this OpenCode.`
    case 'vault-mode-off':
      return `claustrum-auth: vault mode is off for the claustrum-auth plugin; run its setup with --claustrum, or ${command} release ${provider}.`
    case 'account-missing':
      return `claustrum-auth: the vault served no account for ${provider}.`
    case 'account-path-invalid':
      return `claustrum-auth: the request path for ${provider} has no account segment.`
    case 'body-too-large':
      return `claustrum-auth: the request body for ${provider} is too large to send with a vault key.`
    case 'redirect-limit':
      return `claustrum-auth: too many redirects for ${provider}.`
    default:
      return `claustrum-auth: ${code} for ${provider}.`
  }
}

// The vault answered, but the plugin could not save its account list for the
// provider, so whether the vault has an account for it is not known yet.
export function unsavedRosterMessage(provider: string, cause: string): string {
  return `claustrum-auth: the local account list for ${provider} could not be saved (${cause}), so the plugin cannot tell yet whether the vault has an account for ${provider}. Nothing changed; run ${command} use ${provider} again.`
}

export const concurrentWriteWarning =
  'Do not run this while logging in to any provider elsewhere: OpenCode rewrites the whole auth file on every login, so a login that lands at the same moment can be lost.'
