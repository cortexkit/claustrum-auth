// The test build of the OpenCode 2 entry, bundled into a scratch directory
// and loaded by the real host. It is the published `setupServer` with two
// test-only inputs: fixture providers whose only allowed origin is the
// loopback mock, and a vault client that talks to the test's fake vault.
// Everything between them (hub, custody, consumers, the gated installer and
// the adapter) is the code that ships.
//
// It also records, for the test to read: the providers it registered, the
// installer's select, limit and retry events, every transport hook call and
// session event with its order, and what the host's retry hook was handed.
// None of these records ever holds a served secret: only provider ids,
// account ids, kinds, sessions, and whether a header was the placeholder.
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import {
  type ClaustrumScopedClient,
  ClaustrumUnreachableError,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import {
  createTestCore,
  fixtureEntries,
  type ProviderEntry,
} from '../../../../core/test-entry.ts'
import { opencodeStateDir } from '../../../src/state-dir.ts'
import { setupServer } from '../../../src/v2/setup.ts'
import { startupError } from './startup-error.ts'

const env = (name: string) => process.env[name] ?? ''
const VAULT = env('CLAUSTRUM_AUTH_E2E_VAULT')
const STATE = env('CLAUSTRUM_AUTH_E2E_STATE')
const LOG = env('CLAUSTRUM_AUTH_E2E_LOG')
const ORIGIN = env('CLAUSTRUM_AUTH_E2E_ORIGIN')

let seq = 0
function log(event: string, data: Record<string, unknown> = {}) {
  if (LOG)
    appendFileSync(
      LOG,
      `${JSON.stringify({ seq: ++seq, at: Date.now(), event, ...data })}\n`,
    )
}

log('import', { platform: process.platform, versions: process.versions })

const base = (id: string) => {
  const entry = fixtureEntries.find((candidate) => candidate.service === id)
  if (!entry) throw new Error(`missing fixture ${id}`)
  return entry
}
const classA = (id: string): ProviderEntry => ({
  ...base('fixture-a'),
  service: id,
  ids: [id],
  hosts: { opencode2: id },
  origins: [ORIGIN],
})

/**
 * `fixture-a`, `fixture-b` (account segment) and `fixture-c` (class C) as in
 * core, plus two class-A twins with their own configuration: `fixture-h`
 * gets an extra configured header carrying its placeholder, and `fixture-o`
 * a base URL on another origin.
 */
export const table: readonly ProviderEntry[] = [
  classA('fixture-a'),
  {
    ...base('fixture-b'),
    hosts: { opencode2: 'fixture-b' },
    origins: [ORIGIN],
  },
  {
    ...base('fixture-c'),
    hosts: { opencode2: 'fixture-c' },
    origins: [ORIGIN],
  },
  classA('fixture-h'),
  classA('fixture-o'),
]

async function call(op: string, body: Record<string, unknown> = {}) {
  let reply: { result?: unknown; error?: string; offline?: boolean }
  try {
    const response = await fetch(`${VAULT}/${op}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    reply = (await response.json()) as typeof reply
  } catch {
    throw new ClaustrumUnreachableError()
  }
  if (reply.offline) throw new ClaustrumUnreachableError()
  if (reply.error)
    throw Object.assign(new Error(reply.error), { code: reply.error })
  return reply.result
}

const client: ClaustrumScopedClient = {
  listScoped: async () =>
    (await call('list')) as Awaited<
      ReturnType<ClaustrumScopedClient['listScoped']>
    >,
  getScoped: async ({ credentialId }) =>
    (await call('get', { credentialId })) as Awaited<
      ReturnType<ClaustrumScopedClient['getScoped']>
    >,
  reportAuthFailureScoped: async ({
    credentialId,
    providerStatus,
    recordVersion,
  }) => {
    await call('report', { credentialId, providerStatus, recordVersion })
  },
  close() {},
}

async function mode(): Promise<'vault' | 'local'> {
  try {
    const response = await fetch(`${VAULT}/mode`, { method: 'POST' })
    return ((await response.json()) as { result: 'vault' | 'local' }).result
  } catch {
    return 'vault'
  }
}

function carries(headers: Headers, value: string) {
  return [...headers].filter(([, v]) => v.includes(value)).map(([name]) => name)
}

const plugin = {
  id: 'cortexkit.claustrum-auth.e2e',
  async setup(ctx: Plugin.Context) {
    const fromSetup = process.env.CLAUSTRUM_AUTH_E2E_SETUP === '1'
    const stateDir = fromSetup ? await opencodeStateDir() : STATE
    const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
    const authority = fromSetup
      ? () => enrollmentAuthority(paths, 'claustrum-auth-opencode')
      : mode
    const tokenPath = fromSetup
      ? paths.tokenPath
      : path.join(STATE, 'token.json')
    log('enrollment-token-start', { tokenPath })
    if (!fromSetup)
      await writeEnrollmentTokenFile(tokenPath, {
        token: '01'.repeat(32),
        token_generation: 1,
      })
    log('enrollment-token-ready')
    const abort = new AbortController()
    const ids = table.map((entry) => entry.hosts.opencode2 as string)
    // Registered before the installer, so they see each transport as the
    // host built it.
    const observers: { dispose(): Promise<void> }[] = []
    for (const provider of ids) {
      observers.push(
        await ctx.session.hook(
          'http.request',
          (draft) => {
            log('transport', {
              provider,
              sessionID: draft.sessionID,
              kind: draft.kind,
              placeholderIn: carries(
                draft.request.headers,
                placeholderSecret(provider),
              ),
            })
          },
          { providerID: provider },
        ),
      )
    }
    observers.push(
      await ctx.session.hook('prompt', (draft) => {
        log('prompt', { sessionID: draft.sessionID })
      }),
    )
    const cleanup = await setupServer(ctx, {
      table,
      authority,
      createCore: (facts) => {
        log('facts', {
          catalog: facts.catalog.filter((id) => id.startsWith('fixture-')),
        })
        const core = createTestCore(
          {
            facts,
            stateDir,
            tokenPath,
            isCustodyActive: async () => (await authority()) === 'vault',
            connect: async () => client,
          },
          table,
        )
        log('registered', {
          providers: core.entries.map((entry) => entry.hosts.opencode2),
        })
        return core
      },
      onError: (error) =>
        log('plugin-error', {
          name: error instanceof Error ? error.name : typeof error,
        }),
      observe: (provider, installation) => {
        installation.on('select', (event) =>
          log('select', {
            provider,
            sessionID: event.sessionID,
            kind: event.kind,
            accountId: event.accountId,
          }),
        )
        installation.on('limit', (event) =>
          log('limit', {
            provider,
            sessionID: event.sessionID,
            accountId: event.accountId,
            status: event.limit.status,
          }),
        )
        installation.on('retry', (event) =>
          log('retry', {
            provider,
            sessionID: event.sessionID,
            accountId: event.accountId,
            reason: event.reason,
            hostDecision: event.hostDecision,
            decision: event.decision,
          }),
        )
      },
    })
    // Registered after the installer, so it sees the final decision.
    for (const provider of ids) {
      observers.push(
        await ctx.session.hook(
          'retry',
          (draft) => {
            log('host-retry', {
              provider,
              sessionID: draft.sessionID,
              error: { type: draft.error.type, message: draft.error.message },
              decision: draft.decision,
            })
          },
          { providerID: provider },
        ),
      )
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: abort.signal,
        })) {
          if (event.type.startsWith('session.execution.'))
            log('execution', {
              type: event.type,
              sessionID: (event.data as { sessionID?: string }).sessionID,
            })
        }
      } catch {}
    })()
    log('setup')
    return async () => {
      abort.abort()
      for (const observer of observers) await observer.dispose()
      await cleanup()
    }
  },
}

export default {
  id: plugin.id,
  async setup(ctx: Plugin.Context) {
    log('setup-start', { state: STATE })
    try {
      return await plugin.setup(ctx)
    } catch (error) {
      log('setup-error', { error: startupError(error) })
      throw error
    }
  },
}
