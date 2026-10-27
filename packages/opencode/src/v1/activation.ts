import { transitionActivation } from '@cortexkit/claustrum-auth-core'
import { type EffectiveCredential, effectiveCredential } from './effective.js'
import type { ReleasedFlags } from './flags.js'
import {
  concurrentWriteWarning,
  refusalMessage,
  unsavedRosterMessage,
  userCredentialMessage,
} from './messages.js'
import {
  isPlaceholderEntry,
  placeholderFor,
  type StoredEntry,
} from './placeholder.js'

// OpenCode 1's own auth API. It has no compare-and-set: `set` and `remove` are
// unlocked whole-file rewrites, so the plugin can only re-read before and
// after each write (see `useProvider` and `releaseProvider`).
export interface AuthApi {
  read(provider: string): Promise<StoredEntry>
  set(provider: string, entry: { type: 'api'; key: string }): Promise<void>
  remove(provider: string): Promise<void>
  // Set when OpenCode reads stored credentials from `OPENCODE_AUTH_CONTENT`
  // instead of auth.json, so a written placeholder would never be read.
  contentOverride(): boolean
}

export interface ActivationContext {
  auth: AuthApi
  flags: ReleasedFlags
  listed(provider: string): boolean
  // Fresh `enrollmentAuthority()` and a hub refresh; resolves whether vault
  // mode is on and whether the provider has a routable vault row. `unsaved`
  // names why the vault's list for the provider could not be saved, when the
  // vault answered but the plugin still holds no list for it.
  vault(provider: string): Promise<{
    vaultOn: boolean
    routable: boolean
    unsaved?: string
  }>
  // What else could make a user key effective: environment and config.
  env(): Readonly<Record<string, string | undefined>>
  envNames(provider: string): Promise<readonly string[]>
  configApiKey(provider: string): boolean
  platform?: NodeJS.Platform
}

export interface CommandOutcome {
  ok: boolean
  message: string
}

const nextStart = 'It takes effect the next time OpenCode starts.'

async function userCredential(
  context: ActivationContext,
  provider: string,
  stored: StoredEntry,
): Promise<EffectiveCredential | undefined> {
  return effectiveCredential({
    provider,
    stored,
    env: context.env(),
    envNames: await context.envNames(provider),
    configApiKey: context.configApiKey(provider),
  })
}

// `/claustrum use <P>`: write the placeholder only into an empty slot with no
// effective user credential. The stored entry is read again and the check
// re-run as the last step before the write, so a credential present at that
// read is never overwritten. A login that lands between that read and the
// write cannot be seen and is lost, as with two concurrent host logins; the
// read after the write detects only a value written after the plugin's.
export async function useProvider(
  context: ActivationContext,
  provider: string,
): Promise<CommandOutcome> {
  const platform = context.platform ?? process.platform
  if (!context.listed(provider))
    return {
      ok: false,
      message: `claustrum-auth: ${provider} is not a provider the claustrum-auth plugin serves on this OpenCode.`,
    }
  if (context.auth.contentOverride())
    return {
      ok: false,
      message:
        'claustrum-auth: OPENCODE_AUTH_CONTENT is set, so OpenCode reads stored credentials from that variable and would never read the vault placeholder; unset it first.',
    }
  const stored = await context.auth.read(provider)
  if (isPlaceholderEntry(stored, provider)) {
    await context.flags.set(provider, false)
    return {
      ok: true,
      message: `claustrum-auth: ${provider} already uses the vault.`,
    }
  }
  const early = await userCredential(context, provider, stored)
  if (early)
    return {
      ok: false,
      message: userCredentialMessage(provider, early, platform),
    }
  const { unsaved, ...vault } = await context.vault(provider)
  if (unsaved !== undefined)
    return { ok: false, message: unsavedRosterMessage(provider, unsaved) }
  const activated = transitionActivation(
    {
      host: 'opencode1',
      status: 'available',
      consented: false,
      released: await context.flags.isReleased(provider),
      vaultOn: vault.vaultOn,
      routable: vault.routable,
      automatic: false,
    },
    { type: 'activate', ...vault, effectiveKey: false },
  )
  if (activated.refusal)
    return { ok: false, message: refusalMessage(activated.refusal, provider) }
  // The last read before the write.
  const last = await context.auth.read(provider)
  if (!isPlaceholderEntry(last, provider)) {
    const late = await userCredential(context, provider, last)
    if (late)
      return {
        ok: false,
        message: userCredentialMessage(provider, late, platform),
      }
    await context.auth.set(provider, {
      type: 'api',
      key: placeholderFor(provider),
    })
    const after = await context.auth.read(provider)
    if (!isPlaceholderEntry(after, provider))
      return {
        ok: false,
        message: `claustrum-auth: another login for ${provider} changed while the vault placeholder was being written; the plugin left it as it is.`,
      }
  }
  await context.flags.set(provider, false)
  return {
    ok: true,
    message: `claustrum-auth: ${provider} now uses the vault. ${nextStart}`,
  }
}

// `/claustrum release <P>`: persist `released` first, then remove the stored
// entry only if the last read shows exactly the plugin's placeholder.
export async function releaseProvider(
  context: ActivationContext,
  provider: string,
): Promise<CommandOutcome> {
  if (!context.listed(provider))
    return {
      ok: false,
      message: `claustrum-auth: ${provider} is not a provider the claustrum-auth plugin serves on this OpenCode.`,
    }
  await context.flags.set(provider, true)
  const last = await context.auth.read(provider)
  if (last === undefined)
    return {
      ok: true,
      message: `claustrum-auth: ${provider} is released; no vault placeholder was stored.`,
    }
  if (!isPlaceholderEntry(last, provider))
    return {
      ok: true,
      message: `claustrum-auth: ${provider} is released; its stored login is your own and was left as it is.`,
    }
  await context.auth.remove(provider)
  const after = await context.auth.read(provider)
  if (after !== undefined)
    return {
      ok: false,
      message: `claustrum-auth: ${provider} is released, but another login for ${provider} changed while the vault placeholder was being removed; the plugin left it as it is.`,
    }
  return {
    ok: true,
    message: `claustrum-auth: ${provider} is released and its vault placeholder removed. ${nextStart}`,
  }
}

export function commandHelp(): string {
  return [
    'claustrum-auth commands:',
    '  use <provider>      store the vault placeholder for <provider> (only when you have no key of your own for it)',
    '  release <provider>  stop using the vault for <provider> and remove its placeholder',
    concurrentWriteWarning,
  ].join('\n')
}
