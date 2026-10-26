import {
  type CoreOptions,
  command,
  opencodeEnrollment,
  type ProviderEntry,
  reservedProviders,
} from '@cortexkit/claustrum-auth-core'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  type ClaustrumConsumer,
  type ClaustrumDiscoveryHub,
  type ClaustrumScopedClient,
  connectClaustrumScopedClient,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import {
  type ActivationContext,
  type AuthApi,
  commandHelp,
  releaseProvider,
  useProvider,
} from './activation.js'
import { hostEnvironment } from './effective.js'
import { providerFetch } from './fetch.js'
import { ReleasedFlags } from './flags.js'
import { hostAuthApi } from './host-auth.js'
import { opencodeAuthFile, pluginStateDir } from './paths.js'

type Env = Readonly<Record<string, string | undefined>>
type Core = {
  hub: ClaustrumDiscoveryHub
  consumers: ReadonlyMap<string, ClaustrumConsumer>
  entries: readonly ProviderEntry[]
}

export interface OpenCode1PluginOptions {
  // The supported-provider table and the core built from it. The published
  // entry passes the shipped table; only the unpublished test entry passes
  // fixture services.
  table: readonly ProviderEntry[]
  createCore: (options: CoreOptions) => Core
  env?: () => Env
  stateDir?: () => string
  authFile?: () => string
  connect?: () => Promise<ClaustrumScopedClient>
  isCustodyActive?: () => Promise<boolean>
  authApi?: (input: PluginInput) => AuthApi
  platform?: NodeJS.Platform
}

export const commandName = command.slice(1)
const handled = '__CLAUSTRUM_AUTH_COMMAND_HANDLED__'

type Shared = { core: Core; holders: number }
// OpenCode 1 runs a plugin once per project instance, all in one process. The
// hub is the process's only vault connection, so instances with the same
// state share it through a process-wide registry.
const registryKey = Symbol.for('@cortexkit/claustrum-auth/opencode1-hubs')
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Shared>
}
const registry = processState[registryKey] ?? new Map<string, Shared>()
processState[registryKey] = registry

type ProviderBlock = {
  env?: unknown
  options?: Record<string, unknown>
  [key: string]: unknown
}

export function opencode1Hosts(
  options: OpenCode1PluginOptions,
  input: PluginInput,
): Hooks {
  const env = options.env ?? (() => process.env)
  const stateDir = (options.stateDir ?? (() => pluginStateDir(env())))()
  const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
  const isCustodyActive =
    options.isCustodyActive ??
    (async () =>
      (await enrollmentAuthority(paths, opencodeEnrollment)) === 'vault')
  const catalog = options.table
    .map((entry) => entry.hosts.opencode1)
    .filter((id): id is string => !!id)
  const key = JSON.stringify([stateDir, paths.tokenPath, catalog])
  let shared = registry.get(key)
  if (!shared) {
    const connectionFile = resolveClaustrumConnectionPath()
    const core = options.createCore({
      stateDir,
      tokenPath: paths.tokenPath,
      connect:
        options.connect ??
        (() => connectClaustrumScopedClient({ connectionFile })),
      isCustodyActive,
      // Every opencode1 id in the table was audited against OpenCode 1's
      // catalog before it was listed (design section 14.4).
      facts: { host: 'opencode1', catalog },
    })
    core.hub.start()
    shared = { core, holders: 0 }
    registry.set(key, shared)
  }
  shared.holders++
  const { core } = shared
  const listed = new Map(
    core.entries.flatMap((entry) => {
      const id = entry.hosts.opencode1
      return id && !reservedProviders.some((reserved) => reserved === id)
        ? [[id, entry] as const]
        : []
    }),
  )
  const auth = (options.authApi ?? defaultAuthApi(options, env))(input)
  const flags = new ReleasedFlags(stateDir)
  const configEnv = new Map<string, readonly string[]>()
  const configApiKey = new Set<string>()
  let catalogEnv: Promise<Map<string, readonly string[]>> | undefined
  const lookupCatalogEnv = async () => {
    const result = (await input.client.provider.list()) as {
      data?: { all?: { id: string; env?: string[] }[] }
    }
    const all = result.data?.all
    if (!all) throw new Error('provider list unavailable')
    return new Map(all.map((provider) => [provider.id, provider.env ?? []]))
  }
  // The provider's environment variable names: the config block's own `env`
  // and the host catalog's, read once from the host's provider list.
  const envNames = async (provider: string) => {
    const names = new Set(configEnv.get(provider) ?? [])
    try {
      catalogEnv ??= lookupCatalogEnv()
      for (const name of (await catalogEnv).get(provider) ?? []) names.add(name)
    } catch {
      catalogEnv = undefined
    }
    return [...names]
  }
  const context: ActivationContext = {
    auth,
    flags,
    listed: (provider) => listed.has(provider),
    async vault(provider) {
      const vaultOn = await isCustodyActive()
      if (!vaultOn) return { vaultOn, routable: false }
      try {
        await core.hub.refresh()
      } catch {
        // An unreachable vault leaves the last committed roster in place.
      }
      const consumer = core.consumers.get(provider)
      return { vaultOn, routable: !!consumer?.routingRows().length }
    },
    env: () => hostEnvironment(env() as NodeJS.ProcessEnv),
    envNames,
    configApiKey: (provider) => configApiKey.has(provider),
    platform: options.platform,
  }

  async function show(sessionID: string, text: string) {
    await input.client.session
      .promptAsync({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: 'text', text, ignored: true }] },
      })
      .catch(() => {})
  }

  return {
    async config(config) {
      const commands = (config.command ?? {}) as Record<string, unknown>
      config.command = {
        ...commands,
        [commandName]: {
          template: commandName,
          description:
            'claustrum-auth: use or release the vault for a provider (use <provider>, release <provider>).',
        },
      } as typeof config.command
      const loose = config as { provider?: Record<string, ProviderBlock> }
      loose.provider ??= {}
      const providers = loose.provider
      for (const [provider, entry] of listed) {
        providers[provider] ??= {}
        const block = providers[provider]
        block.options ??= {}
        const blockOptions = block.options
        if (Array.isArray(block.env))
          configEnv.set(
            provider,
            block.env.filter(
              (name): name is string => typeof name === 'string',
            ),
          )
        if (blockOptions.apiKey !== undefined) configApiKey.add(provider)
        const consumer = core.consumers.get(provider)
        if (!consumer) continue
        const previous =
          typeof blockOptions.fetch === 'function'
            ? (blockOptions.fetch as typeof fetch)
            : undefined
        blockOptions.fetch = providerFetch({
          provider,
          entry,
          consumer,
          previous,
          envNames: () => envNames(provider),
          env: () => hostEnvironment(env() as NodeJS.ProcessEnv),
          platform: options.platform,
        })
      }
    },
    async 'command.execute.before'(hook) {
      if (hook.command !== commandName) return
      const [action, provider, ...rest] = hook.arguments.trim().split(/\s+/u)
      let text: string
      if (
        (action === 'use' || action === 'release') &&
        provider &&
        !rest.length
      ) {
        try {
          const outcome =
            action === 'use'
              ? await useProvider(context, provider)
              : await releaseProvider(context, provider)
          text = outcome.message
        } catch (error) {
          text = `claustrum-auth: ${action} ${provider} failed: ${error instanceof Error ? error.message : String(error)}`
        }
      } else text = commandHelp()
      await show(hook.sessionID, text)
      // OpenCode 1 has no way for a command hook to finish a command without
      // a model turn, so the handled command ends with this fixed error.
      throw new Error(handled)
    },
    async dispose() {
      const current = registry.get(key)
      if (!current || --current.holders > 0) return
      registry.delete(key)
      await current.core.hub.dispose()
    },
  }
}

function defaultAuthApi(options: OpenCode1PluginOptions, env: () => Env) {
  return (input: PluginInput) =>
    hostAuthApi(
      input.client,
      input.serverUrl,
      options.authFile ?? (() => opencodeAuthFile(env())),
      env,
    )
}
