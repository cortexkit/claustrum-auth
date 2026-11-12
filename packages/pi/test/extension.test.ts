import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ClaustrumConsumerError } from '@cortexkit/common-auth/claustrum'
import { openPiSlot } from '@cortexkit/common-auth/pi-slot'
import type { Api, Model } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { setTestEnv } from '../../core/test/env.ts'
import { harness, row } from '../../core/test/fakes.ts'
import { installVaultHost } from '../../core/test/host.ts'
import { installRoutingAccessor } from '../../core/test/routing-accessor-fixture.ts'
import { routing } from '../../core/test/routing-fixtures.ts'
import { createTestCore } from '../../core/test-entry.ts'
import { createPiExtension, placeholderKey } from '../src/extension.ts'
import { FlagStore } from '../src/flags.ts'
import extension from '../src/index.ts'
import { bearerApi, ownedModels } from '../src/models.ts'
import { agentDir, scratch } from './harness.ts'

const model = (id: string, api: string) =>
  ({ id, api, provider: 'p', baseUrl: 'https://p.invalid' }) as Model<Api>

test('the served api is the bearer api most models use, completions on a tie, none without one', () => {
  expect(
    bearerApi([
      model('a', 'openai-responses'),
      model('b', 'openai-responses'),
      model('c', 'openai-completions'),
      model('d', 'anthropic-messages'),
      model('e', 'anthropic-messages'),
      model('f', 'anthropic-messages'),
    ]),
  ).toBe('openai-responses')
  expect(
    bearerApi([
      model('a', 'openai-responses'),
      model('b', 'openai-completions'),
    ]),
  ).toBe('openai-completions')
  expect(bearerApi([model('a', 'anthropic-messages')])).toBeUndefined()
})

test('the owned form keeps only models of the served api, without their provider', () => {
  const owned = ownedModels(
    [
      model('a', 'openai-completions'),
      model('b', 'anthropic-messages'),
      model('c', 'openai-completions'),
    ],
    'openai-completions',
  )
  expect(owned.map((entry) => entry.id)).toEqual(['a', 'c'])
  expect(owned.every((entry) => !('provider' in entry))).toBe(true)
  expect(owned[0]).toMatchObject({ baseUrl: 'https://p.invalid' })
})

test('flags persist across a reload, and a damaged file grants neither consent nor release', async () => {
  const dir = path.join(await scratch('flags'), 'state')
  await mkdir(dir)
  const store = new FlagStore(dir)
  await store.set('fixture-a', { consented: true, released: true })
  const reloaded = new FlagStore(dir)
  await reloaded.load()
  expect(reloaded.get('fixture-a')).toEqual({
    consented: true,
    released: true,
  })
  expect(reloaded.get('fixture-b')).toEqual({
    consented: false,
    released: false,
  })
  await writeFile(path.join(dir, 'pi-activation.json'), '{"version":1,')
  const damaged = new FlagStore(dir)
  await damaged.load()
  expect(damaged.get('fixture-a')).toEqual({
    consented: false,
    released: false,
  })
})

test('flags never create the state folder, which setup creates owner-only', async () => {
  const dir = path.join(await scratch('flags'), 'missing')
  const store = new FlagStore(dir)
  await store.set('fixture-a', { consented: false, released: true })
  expect(existsSync(dir)).toBe(false)
  expect(store.get('fixture-a').released).toBe(true)
  await mkdir(dir)
  await store.set('fixture-a', { consented: false, released: true })
  expect(
    JSON.parse(await readFile(path.join(dir, 'pi-activation.json'), 'utf8')),
  ).toEqual({
    version: 1,
    providers: { 'fixture-a': { consented: false, released: true } },
  })
  await rm(dir, { recursive: true })
})

test('loading the extension registers /claustrum and session hooks and touches nothing else', () => {
  const calls: string[] = []
  const pi = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (...args: unknown[]) =>
          calls.push(`${String(key)}:${String(args[0])}`),
    },
  ) as ExtensionAPI
  extension(pi)
  expect(calls.sort()).toEqual([
    'on:session_shutdown',
    'on:session_start',
    'registerCommand:claustrum',
  ])
})

const servedProvider = 'fixture-a'

test('Pi startup refusal names model registration and the remedy without echoing the host error', async () => {
  const h = await harness([])
  const agent = await agentDir({})
  setTestEnv('PI_CODING_AGENT_DIR', agent.agent)
  const handlers: Record<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  > = {}
  let commandHandler:
    | ((args: string, ctx: unknown) => Promise<void>)
    | undefined
  const notices: string[] = []
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers[name] = handler
    },
    registerCommand(
      _name: string,
      command: { handler: typeof commandHandler },
    ) {
      commandHandler = command.handler
    },
    registerProvider() {
      throw Object.assign(
        new Error('private provider text /secret/profile/models.json'),
        {
          code: 'private-provider-code',
        },
      )
    },
  } as unknown as ExtensionAPI
  const context = {
    modelRegistry: {
      getAll: () => [
        { provider: servedProvider, id: 'm', api: 'openai-completions' },
      ],
    },
    ui: { notify: (message: string) => notices.push(message) },
    cwd: agent.agent,
  } as unknown as ExtensionContext
  createPiExtension({
    createCore: (options) =>
      createTestCore({ ...options, connect: async () => h.client }),
  })(pi)
  await handlers.session_start?.({}, context)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(
    'could not register Pi providers from models.json',
  )
  expect(notices[0]).toContain(
    'Check models.json for invalid or empty provider definitions, then restart Pi.',
  )
  expect(notices[0]).not.toMatch(/private|secret|profile|\bio\b/)
  await commandHandler?.('status', context)
  expect(notices[1]).toBe(notices[0])
  await handlers.session_shutdown?.({}, context)
})

// One turn through the extension's own serving path, in this process: the
// provider's streamSimple is what Pi calls, and `fetch` stands in for the
// transport that sends to the provider. `withdraw` can make the vault refuse
// the route the way it does when the account was disabled, removed or changed
// after the roster read, and nothing is ever sent when it does.
async function servedTurn(options: {
  withdraw?: (core: ReturnType<typeof createTestCore>) => void
  hosted?: 'missing' | 'relay'
}) {
  const h = await harness(options.hosted ? [row('a')] : [])
  const relay = options.hosted
    ? installVaultHost(options.hosted === 'relay' ? h.client : undefined)
    : undefined
  let nativeConnects = 0
  let core: ReturnType<typeof createTestCore> | undefined
  const agent = await agentDir({
    enrolled: !options.hosted,
    ...(options.hosted
      ? {
          auth: {
            [servedProvider]: { type: 'api_key', key: 'seeded-user-key' },
          },
        }
      : {}),
    flags: { [servedProvider]: { consented: true } },
  })
  setTestEnv('PI_CODING_AGENT_DIR', agent.agent)
  if (options.hosted === 'missing')
    await openPiSlot({
      authPath: agent.authPath,
      provider: servedProvider,
      stashPath: path.join(agent.state, 'pi-slots', `${servedProvider}.json`),
      placeholderKey: placeholderKey(servedProvider),
    }).enterVault()
  let registered: Record<string, unknown> | undefined
  const handlers: Record<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  > = {}
  let commandHandler:
    | ((args: string, ctx: unknown) => Promise<void>)
    | undefined
  const notices: string[] = []
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers[name] = handler
    },
    registerCommand(
      _name: string,
      command: { handler: typeof commandHandler },
    ) {
      commandHandler = command.handler
    },
    unregisterProvider() {},
    registerProvider(_name: string, value: Record<string, unknown>) {
      registered = value
    },
  } as unknown as ExtensionAPI
  const context = {
    modelRegistry: {
      getAll: () => [
        { provider: servedProvider, id: 'm', api: 'openai-completions' },
      ],
      refresh: async () => {},
    },
    ui: {
      notify(message: string) {
        notices.push(message)
      },
      confirm: async () => true,
    },
    cwd: process.cwd(),
  } as unknown as ExtensionContext
  createPiExtension({
    // The provider is registered while the session starts, so one core is
    // built and handed back on every later call.
    createCore(built) {
      core ??= createTestCore({
        ...built,
        connect: async () => {
          nativeConnects++
          return h.client
        },
      })
      return core
    },
  })(pi)
  await handlers.session_start?.({}, context)
  if (options.withdraw && core) options.withdraw(core)
  const stream = registered?.streamSimple as (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => AsyncIterable<{ error?: { errorMessage?: string } }>
  let sends = 0
  let message = ''
  const authorizations: string[] = []
  for await (const event of stream(
    {
      provider: servedProvider,
      id: 'm',
      api: 'openai-completions',
      baseUrl: 'https://fixture.invalid/v1',
      input: ['text'],
      output: ['text'],
    },
    { messages: [] },
    {
      apiKey: placeholderKey(servedProvider),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        sends++
        authorizations.push(
          new Request(input, init).headers.get('authorization') ?? '',
        )
        return new Response('not a stream')
      },
    },
  ))
    message = event.error?.errorMessage ?? message
  if (options.hosted) {
    await commandHandler?.('', context)
    expect(notices.at(-1)).toContain('Served by Thalamus')
    expect(notices.at(-1)).not.toMatch(/\bConnect\b|\bDisconnect\b/)
    expect(nativeConnects).toBe(0)
    const reads = [...h.reads]
    for await (const _event of stream(
      {
        provider: servedProvider,
        id: 'm',
        api: 'openai-completions',
        baseUrl: 'https://fixture.invalid/v1',
        input: ['text'],
        output: ['text'],
      },
      { messages: [] },
      {
        apiKey: 'independent-user-key',
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(new Request(input, init).headers.get('authorization')).toBe(
            'Bearer independent-user-key',
          )
          return new Response('not a stream')
        },
      },
    )) {
    }
    expect(h.reads).toEqual(reads)
  }
  await handlers.session_shutdown?.({}, context)
  return { message, sends, authorizations, relay }
}

test('hosted Pi without a relay refuses an owned turn without falling back to a native key', async () => {
  const { message, sends } = await servedTurn({ hosted: 'missing' })
  expect(message).toContain(
    'the Claustrum vault has no usable account for fixture-a',
  )
  expect(sends).toBe(0)
})

test('hosted Pi serves the relay vault key without enrollment or native connect', async () => {
  const { sends, authorizations, relay } = await servedTurn({ hosted: 'relay' })
  expect(sends).toBe(1)
  expect(authorizations).toEqual(['Bearer secret-a-1'])
  expect(relay?.calls).toEqual(['claustrum-auth'])
})

test('Pi without a session manager stops an API-key request only under routing', async () => {
  installRoutingAccessor()
  const outside = await servedTurn({ hosted: 'relay' })
  expect(outside.sends).toBe(1)
  expect(outside.authorizations).toEqual(['Bearer secret-a-1'])
  const { calls } = routing(async () => ({ account_id: 'account-a' }))
  const { sends, message } = await servedTurn({ hosted: 'relay' })
  expect(message).toContain(
    'Thalamus routing did not answer, so this API key request was not sent.',
  )
  expect(sends).toBe(0)
  expect(calls).toEqual([])
})

test('a route withdrawn while a turn is served gets the plugin text, and nothing is sent', async () => {
  const { message, sends } = await servedTurn({
    withdraw(core) {
      // The account still routes; the vault refuses it at the send, because it
      // was disabled, removed or changed since the roster read.
      const consumer = core.consumers.get(servedProvider)
      if (!consumer) throw new Error(`no ${servedProvider} consumer`)
      consumer.routingRows = () => [{ id: 'vault:gone', kind: 'api-key' }]
      consumer.send = async () => {
        throw new ClaustrumConsumerError(
          'route-unavailable',
          'Claustrum route is disabled, removed or changed',
        )
      }
    },
  })
  expect(message).toContain(
    `no longer serves this account for ${servedProvider}`,
  )
  expect(message).not.toContain('Claustrum route is disabled')
  expect(sends).toBe(0)
})
