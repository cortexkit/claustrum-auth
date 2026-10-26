import path from 'node:path'
import {
  type ActivationEffect,
  type ActivationEvent,
  type ActivationState,
  ClaustrumAuthError,
  type CoreFetch,
  type CoreOptions,
  checkPlacement,
  command,
  type createCore,
  createFetch,
  initialActivation,
  type ProviderEntry,
  piEnrollment,
  SlotQueue,
  transitionActivation,
} from '@cortexkit/claustrum-auth-core'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  type ClaustrumConsumer,
  ClaustrumConsumerError,
  type ClaustrumScopedClient,
  connectClaustrumScopedClient,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { openPiSlot, type PiSlot } from '@cortexkit/common-auth/pi-slot'
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import { FlagStore } from './flags.js'
import {
  activationRefusals,
  conflictText,
  consentText,
  consentTitle,
  enteredText,
  enterFailedText,
  enterIncompleteText,
  exitFailedText,
  missingStashText,
  refusalText,
  releasedText,
  releaseKeptText,
  unknownProvider,
  usage,
} from './messages.js'
import {
  type BearerApi,
  bearerApi,
  isServableModel,
  ownedModels,
} from './models.js'

export type ClaustrumCore = ReturnType<typeof createCore>
export interface PiExtensionOptions {
  createCore(options: CoreOptions): ClaustrumCore
  /** Replaces the Claustrum connection; the production entry never sets it. */
  connect?: () => Promise<ClaustrumScopedClient>
  /** How often vault mode and routable accounts are checked again. */
  syncIntervalMs?: number
}

type Authority = 'vault' | 'local' | 'unreadable'

interface Served {
  provider: string
  entry: ProviderEntry
  api: BearerApi
  placeholder: string
  slot: PiSlot
  consumer: ClaustrumConsumer
  state: ActivationState
  registered?: 'available' | 'owned'
  // The provider's models as Pi composed them while it was not owned.
  models: Model<Api>[]
  marks: Map<string, number>
  lastEnter?: 'entered' | 'failed' | 'incomplete'
  lastExit?: 'restored' | 'conflict' | 'nothing-to-do' | 'failed'
  lastError?: string
}

/** The api_key Pi keeps in a provider's slot while the vault serves it. */
export const placeholderKey = (provider: string) =>
  `cortexkit-claustrum-auth-v1-${provider}`

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'io'
}

// A refusal is answered with a local response rather than a thrown error, so
// pi-ai shows its fixed text and neither the OpenAI SDK nor Pi retries it as a
// connection failure.
function refusalResponse(served: Served, code: string) {
  const message = refusalText(code, served.provider, served.entry)
  return Response.json(
    { error: { message, type: 'claustrum_auth_refused', code } },
    { status: 400, headers: { 'x-claustrum-auth-refusal': code } },
  )
}

// Core rethrows errors from the serving loop through the credential redactor,
// which keeps an error's name and string code but not its class, so refusals
// are recognised by those two fields.
function refusalCode(error: unknown): string | undefined {
  if (error instanceof ClaustrumConsumerError)
    return consumerRefusal(error.kind)
  if (!(error instanceof Error)) return undefined
  const code = (error as { code?: unknown }).code
  if (error.name === 'ClaustrumAuthError' && typeof code === 'string')
    return code
  if (error.name === 'ClaustrumUnreachableError') return 'vault-unreachable'
  if (error.name === 'ClaustrumConsumerError') return 'vault-refused'
  return undefined
}

function consumerRefusal(kind: string) {
  switch (kind) {
    case 'unavailable':
      return 'vault-unreachable'
    case 'not-active':
      return 'vault-mode-off'
    case 'route-unavailable':
    case 'route-declined':
      return 'no-vault-account'
    default:
      return 'vault-refused'
  }
}

function requestParts(input: string | URL | Request, init?: RequestInit) {
  return {
    url: new URL(input instanceof Request ? input.url : input),
    headers: new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ),
  }
}

class PiRuntime {
  readonly served = new Map<string, Served>()
  readonly queue = new SlotQueue()
  #pi: ExtensionAPI
  #ctx: ExtensionContext
  #core: ClaustrumCore
  #flags: FlagStore
  #authority: () => Promise<Authority>
  #notLocal = false
  #syncing = false
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    core: ClaustrumCore,
    flags: FlagStore,
    authority: () => Promise<Authority>,
  ) {
    this.#pi = pi
    this.#ctx = ctx
    this.#core = core
    this.#flags = flags
    this.#authority = authority
  }

  setContext(ctx: ExtensionContext) {
    this.#ctx = ctx
  }

  add(served: Served) {
    this.served.set(served.provider, served)
  }

  // Every slot change, registration and registry refresh of this process runs
  // through one queue, so ten providers never wait on each other for Pi's
  // auth.json lock and their order is deterministic.
  dispatch(served: Served, event: ActivationEvent) {
    return this.queue.run(() => this.#handle(served, event))
  }

  async #handle(served: Served, event: ActivationEvent) {
    const result = transitionActivation(served.state, event)
    served.state = result.state
    for (const effect of result.effects) await this.#effect(served, effect)
    return result
  }

  async #effect(served: Served, effect: ActivationEffect) {
    switch (effect) {
      case 'register-available':
        this.#register(served, 'available')
        return
      case 'register-owned':
        this.#register(served, 'owned')
        return
      case 'persist-flags':
        try {
          await this.#flags.set(served.provider, {
            consented: served.state.consented,
            released: served.state.released,
          })
        } catch {
          this.#ctx.ui.notify(
            `claustrum-auth could not save the ${served.provider} settings; they apply until Pi restarts.`,
            'warning',
          )
        }
        return
      case 'refresh-registry':
        await this.refreshRegistry()
        return
      case 'enter-slot': {
        let outcome: { success: boolean; wrote: boolean }
        try {
          await served.slot.enterVault()
          served.lastEnter = 'entered'
          outcome = { success: true, wrote: true }
        } catch (error) {
          served.lastError = errorCode(error)
          // Keep the owned form whenever the slot was touched: a stash or a
          // placeholder left behind must stay guarded until it is resolved.
          let wrote = true
          try {
            const inspection = await served.slot.inspect()
            wrote =
              inspection.slot === 'placeholder' || inspection.stash === 'valid'
          } catch {}
          served.lastEnter = wrote ? 'incomplete' : 'failed'
          outcome = { success: false, wrote }
        }
        await this.#handle(served, { type: 'entered', ...outcome })
        return
      }
      case 'exit-slot': {
        try {
          served.lastExit = await served.slot.exitVault()
        } catch (error) {
          served.lastExit = 'failed'
          served.lastError = errorCode(error)
        }
        await this.#handle(served, {
          type: 'exited',
          success:
            served.lastExit === 'restored' ||
            served.lastExit === 'nothing-to-do',
        })
        return
      }
    }
  }

  async refreshRegistry() {
    try {
      await this.#ctx.modelRegistry.refresh()
    } catch {
      // Pi keeps its previous view; the next refresh picks the slot up.
    }
  }

  #register(served: Served, form: 'available' | 'owned') {
    if (form === 'owned' && served.registered !== 'owned') {
      // Read the composed models while the available form (or nothing) is
      // registered; the owned form replaces them.
      served.models = this.#ctx.modelRegistry
        .getAll()
        .filter((model) => model.provider === served.provider)
    }
    // Pi merges a re-registration over the previous one and keeps any field it
    // omits, so registering without `models` would keep the owned list. Only
    // removing the registration first brings back Pi's built-in and models.json
    // models (measured in the Pi spike, docs/pi-spike.md).
    if (form === 'available' && served.registered === 'owned')
      this.#pi.unregisterProvider(served.provider)
    this.#pi.registerProvider(served.provider, {
      api: served.api,
      streamSimple: (model, context, options) =>
        this.stream(served, model, context, options),
      ...(form === 'owned'
        ? { models: ownedModels(served.models, served.api) }
        : {}),
    })
    served.registered = form
  }

  stream(
    served: Served,
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    // Only the plugin's own placeholder is owned. A user's key, an env key or a
    // runtime override goes to pi-ai exactly as Pi resolved it.
    if (options?.apiKey !== served.placeholder)
      return streamSimple(model, context, options)
    const inner = (options.fetch ?? globalThis.fetch) as CoreFetch
    return streamSimple(model, context, {
      ...options,
      fetch: this.ownedFetch(served, inner) as typeof fetch,
    })
  }

  ownedFetch(served: Served, inner: CoreFetch): CoreFetch {
    const serve = createFetch({
      entry: served.entry,
      placeholder: served.placeholder,
      consumer: served.consumer,
      fetch: inner,
      rateLimitMarks: served.marks,
    })
    return async (input, init) => {
      try {
        const { url, headers } = requestParts(input, init)
        if (
          checkPlacement(url, headers, served.placeholder, served.entry) ===
          'foreign'
        )
          return await inner(input, init)
        if ((await this.#authority()) !== 'vault')
          throw new ClaustrumAuthError('vault-mode-off')
        return await serve(input, init)
      } catch (error) {
        const code = refusalCode(error)
        if (code) return refusalResponse(served, code)
        throw error
      }
    }
  }

  routable(served: Served) {
    try {
      return served.consumer.routingRows().length > 0
    } catch {
      return false
    }
  }

  // Follow vault mode and discovery. Automatic entry, and leaving every slot
  // when vault mode turns off, are decided by the activation state machine.
  async sync() {
    if (this.#syncing) return
    this.#syncing = true
    try {
      const authority = await this.#authority()
      if (authority !== 'unreadable') {
        const notLocal = authority === 'vault'
        if (notLocal !== this.#notLocal) {
          this.#notLocal = notLocal
          for (const served of this.served.values())
            await this.dispatch(served, {
              type: 'authority',
              vaultOn: notLocal,
            })
        }
      }
      for (const served of this.served.values()) {
        const routable = authority === 'vault' && this.routable(served)
        if (routable !== served.state.routable)
          await this.dispatch(served, { type: 'discovery', routable })
      }
    } finally {
      this.#syncing = false
    }
  }

  async start(notLocal: boolean, syncIntervalMs: number) {
    this.#notLocal = notLocal
    for (const served of this.served.values()) {
      const inspection = await this.queue
        .run(() => served.slot.inspect())
        .catch(() => undefined)
      // A placeholder, or a stash whose swap or restore did not finish, makes
      // the provider owned: it stays guarded until enter or exit resolves it.
      const owned =
        !inspection ||
        inspection.slot === 'placeholder' ||
        inspection.stash === 'valid'
      await this.dispatch(served, {
        type: 'start',
        listed: true,
        placeholder: owned,
        vaultOn: notLocal,
      })
      if (served.state.status !== 'owned' || served.state.pending) continue
      if (served.state.released) {
        await this.dispatch(served, { type: 'release' })
      } else if (
        notLocal &&
        served.state.consented &&
        inspection?.stash === 'valid' &&
        inspection.slot !== 'placeholder'
      ) {
        // pi-slot completes an interrupted swap from its stash.
        await this.queue.run(async () => {
          try {
            await served.slot.enterVault()
          } catch (error) {
            served.lastError = errorCode(error)
          }
          await this.refreshRegistry()
        })
      }
    }
    this.#core.hub.start()
    void this.#core.hub
      .refresh()
      .catch(() => {})
      .then(() => this.sync())
      .catch(() => {})
    this.#timer = setInterval(() => {
      void this.sync().catch(() => {})
    }, syncIntervalMs)
    this.#timer.unref?.()
  }

  async use(provider: string, ctx: ExtensionContext) {
    const served = this.served.get(provider)
    if (!served) {
      ctx.ui.notify(
        unknownProvider(provider) + ([...this.served.keys()].join(', ') || '-'),
        'error',
      )
      return
    }
    const vaultOn = (await this.#authority()) === 'vault'
    if (vaultOn) await this.#core.hub.refresh().catch(() => {})
    const routable = vaultOn && this.routable(served)
    let consented = served.state.consented
    if (vaultOn && routable && !consented && served.state.status !== 'owned') {
      const models = ctx.modelRegistry
        .getAll()
        .filter((model) => model.provider === provider)
      const hidden = models.filter(
        (model) => !isServableModel(model) || model.api !== served.api,
      ).length
      consented = await ctx.ui.confirm(
        consentTitle(provider),
        consentText(provider, hidden),
      )
      if (!consented) {
        ctx.ui.notify(activationRefusals['consent-required'](provider), 'info')
        return
      }
    }
    served.lastEnter = undefined
    const result = await this.dispatch(served, {
      type: 'activate',
      vaultOn,
      routable,
      consented,
    })
    if (result.refusal) {
      ctx.ui.notify(
        (
          activationRefusals[result.refusal] ??
          activationRefusals['no-vault-account']
        )(provider),
        'error',
      )
      return
    }
    if (served.lastEnter === 'failed')
      ctx.ui.notify(enterFailedText(provider), 'error')
    else if (served.lastEnter === 'incomplete')
      ctx.ui.notify(enterIncompleteText(provider), 'error')
    else ctx.ui.notify(enteredText(provider), 'info')
  }

  async release(provider: string, ctx: ExtensionContext) {
    const served = this.served.get(provider)
    if (!served) {
      ctx.ui.notify(
        unknownProvider(provider) + ([...this.served.keys()].join(', ') || '-'),
        'error',
      )
      return
    }
    const wasOwned = served.state.status === 'owned'
    served.lastExit = undefined
    served.lastError = undefined
    await this.dispatch(served, { type: 'release' })
    if (served.state.status !== 'owned') {
      ctx.ui.notify(
        wasOwned ? releasedText(provider) : releaseKeptText(provider),
        'info',
      )
      return
    }
    ctx.ui.notify(
      served.lastExit === 'conflict'
        ? conflictText(provider)
        : served.lastError === 'missing-stash'
          ? missingStashText(provider)
          : exitFailedText(provider),
      'error',
    )
  }

  async status(ctx: ExtensionContext) {
    // Report after any slot change already queued has finished.
    await this.queue.run(async () => {})
    const lines = [...this.served.values()].map((served) => {
      const hidden =
        served.state.status === 'owned'
          ? served.models.filter((model) => model.api !== served.api).length
          : 0
      return `${served.provider}: ${served.state.status}, ${
        this.routable(served) ? served.consumer.routingRows().length : 0
      } vault account(s)${served.state.released ? ', released' : ''}${
        hidden ? `, ${hidden} model(s) hidden` : ''
      }`
    })
    ctx.ui.notify(
      [
        `claustrum-auth: vault mode ${this.#notLocal ? 'on' : 'off'}`,
        ...lines,
        usage,
      ].join('\n'),
      'info',
    )
  }

  async dispose() {
    if (this.#timer) clearInterval(this.#timer)
    await this.queue.run(async () => {}).catch(() => {})
    await this.#core.hub.dispose()
  }
}

async function startRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: PiExtensionOptions,
): Promise<PiRuntime> {
  // Pi's own resolution of its folder: PI_CODING_AGENT_DIR, else the default.
  const agentDir = getAgentDir()
  const stateDir = path.join(agentDir, 'claustrum-auth')
  const paths = hostEnrollmentPaths({ stateDir, host: 'pi' })
  const authority = async (): Promise<Authority> => {
    try {
      return await enrollmentAuthority(paths, piEnrollment)
    } catch {
      return 'unreadable'
    }
  }
  const byProvider = new Map<string, Model<Api>[]>()
  for (const model of ctx.modelRegistry.getAll()) {
    const models = byProvider.get(model.provider) ?? []
    models.push(model)
    byProvider.set(model.provider, models)
  }
  const apis = new Map<string, BearerApi>()
  for (const [provider, models] of byProvider) {
    const api = bearerApi(models)
    if (api) apis.set(provider, api)
  }
  const core = options.createCore({
    stateDir,
    tokenPath: paths.tokenPath,
    connect:
      options.connect ??
      (() =>
        connectClaustrumScopedClient({
          connectionFile: resolveClaustrumConnectionPath(),
          projectRoot: ctx.cwd,
          storagePath: paths.tokenPath,
          logger: () => {},
        })),
    isCustodyActive: async () => (await authority()) === 'vault',
    onError: () => {},
    facts: { host: 'pi', catalog: [...apis.keys()].sort() },
  })
  const flags = new FlagStore(stateDir)
  await flags.load()
  const runtime = new PiRuntime(pi, ctx, core, flags, authority)
  const authPath = path.join(agentDir, 'auth.json')
  for (const entry of core.entries) {
    const provider = entry.hosts.pi as string
    const consumer = core.consumers.get(provider)
    const api = apis.get(provider)
    if (!consumer || !api) continue
    runtime.add({
      provider,
      entry,
      api,
      placeholder: placeholderKey(provider),
      slot: openPiSlot({
        authPath,
        provider,
        stashPath: path.join(stateDir, 'pi-slots', `${provider}.json`),
        placeholderKey: placeholderKey(provider),
      }),
      consumer,
      state: initialActivation('pi', flags.get(provider)),
      models: byProvider.get(provider) ?? [],
      marks: new Map(),
    })
  }
  await runtime.start(
    (await authority()) !== 'local',
    options.syncIntervalMs ?? 5_000,
  )
  return runtime
}

export function createPiExtension(options: PiExtensionOptions) {
  return function claustrumAuth(pi: ExtensionAPI): void {
    let runtime: Promise<PiRuntime | undefined> | undefined
    let latest: ExtensionContext | undefined
    pi.on('session_start', async (_event, ctx) => {
      latest = ctx
      runtime ??= startRuntime(pi, ctx, options).catch((error) => {
        ctx.ui.notify(
          `claustrum-auth did not start: ${errorCode(error)}`,
          'error',
        )
        return undefined
      })
      ;(await runtime)?.setContext(ctx)
    })
    pi.on('session_shutdown', async () => {
      const current = await runtime
      runtime = undefined
      await current?.dispose()
    })
    pi.registerCommand(command.slice(1), {
      description: 'Serve Pi providers with keys from the Claustrum vault',
      handler: async (args, ctx) => {
        latest = ctx
        const current = await runtime
        if (!current) {
          ctx.ui.notify(
            'claustrum-auth is not running in this session.',
            'error',
          )
          return
        }
        current.setContext(latest)
        const [verb, provider] = args.trim().split(/\s+/)
        if (verb === 'use' && provider) await current.use(provider, ctx)
        else if (verb === 'release' && provider)
          await current.release(provider, ctx)
        else await current.status(ctx)
      },
    })
  }
}
