import {
  type CoreFetch,
  createFetch,
  type ProviderEntry,
  type ServingConsumer,
} from '@cortexkit/claustrum-auth-core'
import { hostEnvironment, shadowedVariable } from './effective.js'
import { refusalMessage, shadowedMessage } from './messages.js'
import { placeholderFor } from './placeholder.js'

// A local refusal the user sees as the request's error. Its message is one of
// the fixed texts in messages.ts and never carries request data or a secret.
export class ClaustrumRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ClaustrumRefusal'
  }
}

export interface ProviderFetchOptions {
  provider: string
  entry: ProviderEntry
  consumer: ServingConsumer
  // The `options.fetch` another plugin's config hook set before this one, if
  // any. It still handles every request this plugin does not own.
  previous?: CoreFetch
  // The transport for owned requests; defaults to the global fetch.
  transport?: CoreFetch
  // The provider's catalog environment variable names, for the request-time
  // shadow check.
  envNames: () => Promise<readonly string[]>
  env?: () => Readonly<Record<string, string | undefined>>
  rateLimitMarks?: Map<string, number>
  platform?: NodeJS.Platform
}

// The `provider.<P>.options.fetch` the config hook installs. Classification,
// placement, origin, failover, manual redirects and redaction are the core
// fetch's; this adds the OpenCode 1 environment check and the user's text.
export function providerFetch(options: ProviderFetchOptions): CoreFetch {
  const rateLimitMarks = options.rateLimitMarks ?? new Map<string, number>()
  const previous: CoreFetch =
    options.previous ?? ((input, init) => globalThis.fetch(input, init))
  const transport: CoreFetch =
    options.transport ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    let shadowed: string | undefined
    const core = createFetch({
      entry: options.entry,
      placeholder: placeholderFor(options.provider),
      consumer: options.consumer,
      rateLimitMarks,
      // The core passes a request it does not own on with the caller's own
      // arguments; every owned dispatch is a new Request it built.
      fetch: (next, nextInit) =>
        next === input && nextInit === init
          ? previous(next, nextInit)
          : transport(next, nextInit),
      async effectiveCredential() {
        shadowed = shadowedVariable(
          (options.env ?? hostEnvironment)(),
          await options.envNames(),
        )
        return shadowed !== undefined
      },
    })
    try {
      return await core(input, init)
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'ClaustrumAuthError' &&
        'code' in error
      ) {
        const code = String(error.code)
        throw new ClaustrumRefusal(
          code,
          code === 'credential-shadowed' && shadowed
            ? shadowedMessage(options.provider, shadowed, options.platform)
            : refusalMessage(code, options.provider),
        )
      }
      throw error
    }
  }
}
