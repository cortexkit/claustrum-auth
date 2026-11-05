import { expect, test } from 'bun:test'
import {
  limitFromReply,
  limitMarkUntil,
  localLimitRefusal,
} from '@cortexkit/claustrum-auth-core'
import {
  ClaustrumConsumerError,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import {
  type LimitsNamespace,
  markFromSignal,
  statusVaultOrder,
} from '@cortexkit/common-auth/limits'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import {
  createVaultAdapter,
  inspectResponsesFrame,
  type VaultAttempt,
} from '../../src/v2/adapter.ts'
import { vaultMethodId } from '../../src/v2/setup.ts'
import { phaseClock } from '../phase-clock.ts'
import {
  type FakeHost,
  origin,
  row,
  scope,
  startServer,
  table,
  trigger,
} from './fakes.ts'

const bearer = (provider: string) => ({
  authorization: `Bearer ${placeholderSecret(provider)}`,
})

const balanceTable = table.map((entry, index) =>
  index === 0 ? { ...entry, service: 'deepseek' } : entry,
)

test('20 healthy DeepSeek requests commit no limit state on OpenCode 2', async () => {
  const { host, vault, lastCore } = await startServer({
    table: balanceTable,
    rows: [row('a1')],
    now: () => 1000,
  })
  await login(host, 'fixture-a')
  const core = lastCore()
  if (!core) throw new Error('Expected core')
  const limits = await core.limits('fixture-a')
  const path = core.hub.rosterPath('fixture-a')
  const before = (await readVaultRoster(path))?.limits as
    | LimitsNamespace
    | undefined
  const revision = before?.revision ?? 0
  expect(revision).toBe(0)
  let last = scope('fixture-a')
  for (let request = 0; request < 20; request++) {
    const sent = await send(
      host,
      'fixture-a',
      post(`${origin}/v1`, bearer('fixture-a')),
    )
    expect(
      await (await answer(host, sent, new Response('healthy'))).text(),
    ).toBe('healthy')
    last = sent.scope
  }
  await trigger(host, 'retry', {
    sessionID: last.sessionID,
    agent: last.agent,
    model: last.model,
    error: {
      type: 'provider.unknown',
      message: 'response completed',
      status: 200,
    },
    attempt: 1,
    decision: { retry: false },
  })
  await limits.flush()
  const after = (await readVaultRoster(path))?.limits as
    | LimitsNamespace
    | undefined
  expect(vault.reads).toHaveLength(20)
  expect(after?.revision ?? 0).toBe(revision)
  expect(after?.operationIds.length ?? 0).toBe(0)
})

test('OpenCode 2 payment recovery clears once across subsequent healthy requests', async () => {
  for (const transport of ['http', 'ws']) {
    let time = 1000
    const { host, lastCore } = await startServer({
      table: socketTable.map((entry, index) =>
        index === 0 ? { ...entry, service: 'deepseek' } : entry,
      ),
      rows: [row('a1')],
      now: () => time,
    })
    await login(host, 'fixture-a')
    const core = lastCore()
    if (!core) throw new Error('Expected core')
    const limits = await core.limits('fixture-a')
    const path = core.hub.rosterPath('fixture-a')
    const perform = async (status: number) => {
      const s = scope('fixture-a')
      if (transport === 'http') {
        const sent = await send(
          host,
          'fixture-a',
          post(`${origin}/v1`, bearer('fixture-a')),
          s,
        )
        await (
          await answer(host, sent, new Response('provider reply', { status }))
        ).text()
      } else {
        await handshake(host, 'fixture-a', socketURL, s)
        await receive(
          host,
          s,
          status === 402
            ? '{"type":"error","status":402,"error":{"code":"payment_required"}}'
            : '{"type":"response.completed"}',
        )
      }
      await trigger(host, 'retry', {
        sessionID: s.sessionID,
        agent: s.agent,
        model: s.model,
        error: {
          type: 'provider.unknown',
          message: 'response completed',
          status,
        },
        attempt: 1,
        decision: { retry: false },
      })
    }
    await perform(402)
    await limits.flush()
    time = 2000
    await perform(200)
    await limits.flush()
    const recovered = (await readVaultRoster(path))?.limits as
      | LimitsNamespace
      | undefined
    expect(recovered?.revision).toBe(2)
    for (let request = 0; request < 20; request++) await perform(200)
    await limits.flush()
    const after = (await readVaultRoster(path))?.limits as
      | LimitsNamespace
      | undefined
    expect({ transport, revision: after?.revision }).toEqual({
      transport,
      revision: 2,
    })
    expect(after?.operationIds).toHaveLength(2)
  }
})

test('an expired OpenCode 2 rate probe clears once and fences delayed rate evidence', async () => {
  for (const transport of ['http', 'ws']) {
    let time = 1000
    const { host, lastCore } = await startServer({
      table: socketTable,
      rows: [row('a1')],
      now: () => time,
    })
    await login(host, 'fixture-a')
    const core = lastCore()
    if (!core) throw new Error('Expected core')
    const limits = await core.limits('fixture-a')
    const route = core.consumers.get('fixture-a')?.routingRows()[0].id
    if (!route) throw new Error('Expected route')
    const delayed = limits.observe(route)
    const perform = async (status: number) => {
      const s = scope('fixture-a')
      if (transport === 'http') {
        const sent = await send(
          host,
          'fixture-a',
          post(`${origin}/v1`, bearer('fixture-a')),
          s,
        )
        await (
          await answer(
            host,
            sent,
            new Response('provider reply', {
              status,
              headers: status === 429 ? { 'retry-after': '17' } : {},
            }),
          )
        ).text()
      } else {
        await handshake(host, 'fixture-a', socketURL, s)
        await receive(
          host,
          s,
          status === 429
            ? '{"type":"error","status":429,"error":{"code":"rate_limit_exceeded"}}'
            : '{"type":"response.completed"}',
        )
      }
      await trigger(host, 'retry', {
        sessionID: s.sessionID,
        agent: s.agent,
        model: s.model,
        error: {
          type: 'provider.unknown',
          message: 'response completed',
          status,
        },
        attempt: 1,
        decision: { retry: false },
      })
    }
    await perform(429)
    const until = transport === 'http' ? 18000 : 61000
    time = 2000
    await perform(200)
    expect([...(await limits.marks())].map(([, deadline]) => deadline)).toEqual(
      [until],
    )
    time = until
    await perform(200)
    await limits.beforeDispatch(route)
    const response = new Response('delayed rate refusal', {
      status: 429,
      headers: { 'retry-after': '3600' },
    })
    const signal = await limitFromReply({
      account: delayed.binding.account,
      service: 'fixture-a',
      status: response.status,
      headers: response.headers,
      now: 1000,
    })
    const mark = markFromSignal(signal, statusVaultOrder.markers.opencode2, {
      now: 1000,
    })
    if (!mark) throw new Error('Expected delayed rate mark')
    limits.mark(delayed, mark, 1000)
    await limits.flush()
    expect({ transport, marks: [...(await limits.marks())] }).toEqual({
      transport,
      marks: [],
    })
  }
})

test('a successful OpenCode 2 top-up probe clears an active balance mark through the registry', async () => {
  let time = 1000
  const { host, lastCore } = await startServer({
    table: balanceTable,
    rows: [row('a1')],
    now: () => time,
  })
  const first = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  await answer(
    host,
    first,
    new Response('Insufficient Balance', { status: 402 }),
  )
  const retry = (s: typeof first.scope, status: number) =>
    trigger(host, 'retry', {
      sessionID: s.sessionID,
      agent: s.agent,
      model: s.model,
      error: { type: 'provider.error', message: 'provider reply', status },
      attempt: 1,
      decision: { retry: true, delay: 2000 } as
        | { retry: true; delay: number }
        | { retry: false },
    })
  await retry(first.scope, 402)
  const core = lastCore()
  if (!core) throw new Error('Expected core')
  const limits = await core.limits('fixture-a')
  expect([...(await limits.marks())].map(([, until]) => until)).toEqual([
    301000,
  ])
  time = 2000
  const probe = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  await (await answer(host, probe, new Response('topped up'))).text()
  await retry(probe.scope, 200)
  const route = core.consumers.get('fixture-a')?.routingRows()[0].id
  if (!route) throw new Error('Expected route')
  expect(await limits.beforeDispatch(route)).toBe(true)
  expect([...(await limits.marks())]).toEqual([])
})

test('a successful balance probe cannot erase an in-flight rate-limit observation', async () => {
  for (const service of ['fixture-a', 'deepseek']) {
    let time = 1000
    const { host, lastCore } = await startServer({
      table: table.map((entry, index) =>
        index === 0 ? { ...entry, service } : entry,
      ),
      rows: [row('a1'), row('a2')],
      now: () => time,
    })
    const s = scope('fixture-a')
    const title = await send(
      host,
      'fixture-a',
      post(`${origin}/v1`, bearer('fixture-a')),
      { ...s, kind: 'title' },
    )
    const primary = await send(
      host,
      'fixture-a',
      post(`${origin}/v1`, bearer('fixture-a')),
      s,
    )
    await (await answer(host, title, new Response('healthy title'))).text()
    const core = lastCore()
    if (!core) throw new Error('Expected core')
    const limits = await core.limits('fixture-a')
    const route = core.consumers.get('fixture-a')?.routingRows()[0].id
    if (!route) throw new Error('Expected route')
    // Commit the recovery before the already-dispatched primary reply arrives.
    // Its observation must retain the limits-registry revision captured before
    // recovery and its rate-limit cause.
    await limits.beforeDispatch(route)
    time = 2000
    await answer(
      host,
      primary,
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    )
    const retry = await trigger(host, 'retry', {
      sessionID: s.sessionID,
      agent: s.agent,
      model: s.model,
      error: {
        type: 'provider.rate-limit',
        message: 'rate limited',
        status: 429,
      },
      attempt: 1,
      decision: { retry: true, delay: 2000 } as
        | { retry: true; delay: number }
        | { retry: false },
    })
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const fresh = await send(
      host,
      'fixture-a',
      post(`${origin}/v1`, bearer('fixture-a')),
    )
    expect({
      service,
      authorization: fresh.request.headers.get('authorization'),
    }).toEqual({ service, authorization: 'Bearer secret-a2-1' })
  }
})

test('responseRetry vetoes only owned local refusals, never identical provider or foreign replies', async () => {
  for (const source of ['local', 'provider', 'foreign'] as const) {
    const { host } = await startServer({ rows: [row('a1')] })
    const sent = await send(
      host,
      'fixture-a',
      post(
        `${origin}/v1`,
        source === 'foreign'
          ? { authorization: 'Bearer user-key' }
          : bearer('fixture-a'),
      ),
    )
    const reply = Response.json(
      { error: 'claustrum-auth: accounts-rate-limited' },
      { status: 429 },
    )
    await answer(
      host,
      sent,
      source === 'provider' ? reply : localLimitRefusal(reply),
    )
    const retry = await trigger(host, 'retry', {
      sessionID: sent.scope.sessionID,
      agent: sent.scope.agent,
      model: sent.scope.model,
      error: {
        type: 'provider.error',
        message: 'claustrum-auth: accounts-rate-limited',
        status: 429,
      },
      attempt: 1,
      decision: { retry: true, delay: 2000 } as
        | { retry: true; delay: number }
        | { retry: false },
    })
    expect(retry.decision).toEqual(
      source === 'local' ? { retry: false } : { retry: true, delay: 2000 },
    )
  }
})

function post(url: string, headers: Record<string, string>, body = '{}') {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

async function send(
  host: FakeHost,
  provider: string,
  request: Request,
  s = scope(provider),
) {
  const draft = await trigger(host, 'http.request', { ...s, request })
  return { scope: s, request: draft.request }
}

async function answer(
  host: FakeHost,
  sent: Awaited<ReturnType<typeof send>>,
  response: Response,
) {
  const draft = await trigger(host, 'http.response', {
    ...sent.scope,
    request: sent.request,
    response,
  })
  return draft.response
}

async function login(host: FakeHost, provider: string) {
  const method = host.methods.get(`${provider}:${vaultMethodId}`)
  if (!method) throw new Error(`no vault method for ${provider}`)
  const pending = await method.authorize({})
  return pending.callback
}

test('registers the login method and a gated installation for every supported provider at start, even while the vault is down', async () => {
  const { host, vault } = await startServer({
    offline: true,
    rows: [
      row('a1'),
      row('b1', { providerIds: ['fixture-b'] }),
      row('c1', { providerIds: ['fixture-c'] }),
    ],
    catalog: [
      { id: 'fixture-a' },
      { id: 'fixture-c', integrationID: 'other-integration' },
      { id: 'openai' },
    ],
    table: [
      ...table,
      {
        ...table[0],
        service: 'openai',
        ids: ['openai'],
        hosts: { opencode2: 'openai' },
      },
    ],
  })
  // A reserved provider never gets the method, even when a table names it.
  expect([...host.methods.keys()].sort()).toEqual([
    `fixture-a:${vaultMethodId}`,
    `fixture-b:${vaultMethodId}`,
    `fixture-c:${vaultMethodId}`,
  ])
  // One gated installation per provider, each scoped to its id (the plugin's
  // own request hook sits beside each).
  expect([
    ...new Set(
      (host.hooks.get('http.request') ?? []).map((hook) => hook.providerID),
    ),
  ]).toEqual(['fixture-a', 'fixture-b', 'fixture-c'])
  expect(vault.connects).toBe(0)
  // Activation works without a restart once the vault answers.
  await expect(login(host, 'fixture-a')).rejects.toThrow('could not be reached')
  vault.offline = false
  expect(await login(host, 'fixture-a')).toMatchObject({
    type: 'oauth',
    access: placeholderSecret('fixture-a'),
    methodID: vaultMethodId,
  })
  // Rows for a provider the catalog lacks, or whose integration differs,
  // are refused on this host, so activation finds no account.
  await expect(login(host, 'fixture-b')).rejects.toThrow(
    'no vault account for fixture-b',
  )
  await expect(login(host, 'fixture-c')).rejects.toThrow(
    'no vault account for fixture-c',
  )
})

test('activation refuses with a fixed message when vault mode is off or the provider has no row', async () => {
  const { host, vault } = await startServer({
    rows: [row('b1', { providerIds: ['fixture-b'] })],
  })
  await expect(login(host, 'fixture-a')).rejects.toThrow(
    'no vault account for fixture-a',
  )
  expect(await login(host, 'fixture-b')).toMatchObject({ type: 'oauth' })
  vault.mode = 'local'
  await expect(login(host, 'fixture-b')).rejects.toThrow('vault mode is off')
})

test('an owned request is served in order: origin, authorize, Authorization; nothing else changes', async () => {
  const { host, vault } = await startServer()
  await login(host, 'fixture-a')
  const sent = await send(
    host,
    'fixture-a',
    post(
      `${origin}/v1/chat/completions?x=1`,
      {
        ...bearer('fixture-a'),
        'x-extra': 'kept',
      },
      '{"model":"m"}',
    ),
  )
  expect(sent.request.url).toBe(`${origin}/v1/chat/completions?x=1`)
  expect(sent.request.headers.get('authorization')).toBe('Bearer secret-a1-1')
  expect(sent.request.headers.get('x-extra')).toBe('kept')
  expect(await sent.request.text()).toBe('{"model":"m"}')
  expect(vault.reads).toEqual(['a1'])
  for (const [, value] of sent.request.headers)
    expect(value).not.toContain(placeholderSecret('fixture-a'))
})

test("a route withdrawn after it was chosen is refused with the plugin's own text and sends nothing", async () => {
  // OpenCode 2 chose the account from the roster; the plugin then authorizes
  // it for the send, and the vault reports the route disabled, removed or
  // changed since that read.
  const { host, lastCore } = await startServer()
  await login(host, 'fixture-a')
  const consumer = lastCore()?.consumers.get('fixture-a')
  if (!consumer) throw new Error('no fixture-a consumer')
  consumer.authorize = async () => {
    throw new ClaustrumConsumerError(
      'route-unavailable',
      'Claustrum route is disabled, removed or changed',
    )
  }
  const error = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  ).catch((e) => e)
  expect(error.message).toContain('no longer serves this account for fixture-a')
  expect(error.message).not.toContain('Claustrum route is disabled')
})

test('a wrong origin is refused before any vault read, and the refusal never sees a secret', async () => {
  const { host, vault } = await startServer()
  await login(host, 'fixture-a')
  for (const url of [
    'https://elsewhere.invalid/v1',
    'http://fixture.invalid/v1',
    'https://fixture.invalid:444/v1',
  ]) {
    await expect(
      send(host, 'fixture-a', post(url, bearer('fixture-a'))),
    ).rejects.toThrow(
      'the vault key for fixture-a is only sent to https://fixture.invalid',
    )
  }
  expect(vault.reads).toEqual([])
})

test('a placeholder outside Authorization is refused before selection, with zero vault reads', async () => {
  const { host, vault } = await startServer()
  await login(host, 'fixture-a')
  const before = vault.reads.length
  for (const [headers, text] of [
    [
      { 'x-api-key': placeholderSecret('fixture-a') },
      'sends its key for fixture-a in x-api-key',
    ],
    [
      { ...bearer('fixture-a'), 'x-api-key': placeholderSecret('fixture-a') },
      'carries the key for fixture-a in more than one header',
    ],
  ] as const) {
    await expect(
      send(host, 'fixture-a', post(`${origin}/v1`, headers)),
    ).rejects.toMatchObject({
      kind: 'placement-refused',
      message: expect.stringContaining(text),
    })
  }
  expect(vault.reads.length).toBe(before)
  // Class C is refused even when its placeholder is a bearer.
  await expect(
    send(host, 'fixture-c', post(`${origin}/v1`, bearer('fixture-c'))),
  ).rejects.toThrow('only serves keys sent in Authorization')
  expect(vault.reads.length).toBe(before)
})

test('a foreign request passes untouched with no vault read and no report', async () => {
  const { host, vault } = await startServer()
  const request = post(`https://elsewhere.invalid/v1`, {
    authorization: 'Bearer user-key',
  })
  const sent = await send(host, 'fixture-a', request)
  expect(sent.request).toBe(request)
  const response = new Response('denied', { status: 401 })
  expect(await answer(host, sent, response)).toBe(response)
  expect(vault.reads).toEqual([])
  expect(vault.reports).toEqual([])
})

test('class B rewrites the account segment from the served receipt, after authorizing', async () => {
  const rows = [
    row('b1', { providerIds: ['fixture-b'], accountId: undefined }),
    row('b2', { providerIds: ['fixture-b'], accountId: undefined }),
  ]
  const { host, vault } = await startServer({ rows })
  vault.served.set('b1', 'served-account')
  vault.served.set('b2', undefined)
  await login(host, 'fixture-b')
  const url = `${origin}/client/v4/accounts/configured/ai/v1/chat`
  const sent = await send(host, 'fixture-b', post(url, bearer('fixture-b')))
  expect(sent.request.url).toBe(
    `${origin}/client/v4/accounts/served-account/ai/v1/chat`,
  )
  expect(vault.reads).toEqual(['b1'])
  // With b1 marked limited, b2 serves; its receipt names no account, so the
  // request is refused locally after its one read.
  await answer(
    host,
    sent,
    new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
  )
  await expect(
    send(host, 'fixture-b', post(url, bearer('fixture-b'))),
  ).rejects.toThrow('served no account id for fixture-b')
  expect(vault.reads).toEqual(['b1', 'b2'])
})

test('402 HTTP returns a payment-required limit with Retry-After and a balance probe interval', async () => {
  const adapter = createVaultAdapter({
    entry: balanceTable[0],
    provider: 'fixture-a',
    consumer: async () => undefined,
    rateLimitMarks: new Map(),
    now: () => 1000,
  })
  for (const [value, wait] of [
    [undefined, undefined],
    ['invalid', undefined],
    ['17', 17000],
    ['Thu, 01 Jan 1970 00:00:11 GMT', 10000],
    ['0', 0],
  ] as const) {
    const data: VaultAttempt = {}
    const limit = await adapter.limitFromResponse?.({
      status: 402,
      headers: new Headers(value ? { 'retry-after': value } : {}),
      body: async () => '',
      attempt: {
        providerID: 'fixture-a',
        modelID: 'fixture-model',
        sessionID: 'fixture-session',
        agent: 'fixture-agent',
        kind: 'primary',
        accountId: 'a1',
        attemptId: 'fixture-attempt',
        transport: 'http',
        data,
      },
    })
    expect(limit).toEqual({
      reason: 'payment-required',
      status: 402,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    })
    if (!limit) throw new Error('missing limit')
    if (!data.limit) throw new Error('missing shared limit')
    expect(limitMarkUntil(data.limit, 'opencode2', 1000)).toBe(
      1000 + (wait ?? 300000),
    )
  }
})

test('402 HTTP marks the account and the retry hook moves the turn to the next one without a vault report', async () => {
  const { host, vault } = await startServer({
    table: balanceTable,
    rows: [row('a1'), row('a2')],
  })
  await login(host, 'fixture-a')
  const first = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  await answer(
    host,
    first,
    new Response('insufficient credits', {
      status: 402,
      headers: { 'retry-after': '120' },
    }),
  )
  const retry = await trigger(host, 'retry', {
    sessionID: first.scope.sessionID,
    agent: first.scope.agent,
    model: first.scope.model,
    error: {
      type: 'provider.error',
      message: 'insufficient credits',
      status: 402,
    },
    attempt: 1,
    decision: { retry: false } as
      | { retry: true; delay: number }
      | { retry: false },
  })
  expect(retry.decision).toEqual({ retry: true, delay: 0 })
  await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
    first.scope,
  )
  await send(host, 'fixture-a', post(`${origin}/v1`, bearer('fixture-a')))
  expect(vault.reads).toEqual(['a1', 'a2', 'a2'])
  expect(vault.reports).toEqual([])
})

test('OpenRouter key-cap 402 HTTP stays on the account, unchanged and unmarked', async () => {
  const { host, vault } = await startServer({
    table: table.map((entry) => ({ ...entry, service: 'openrouter' })),
    rows: [row('a1'), row('a2')],
  })
  await login(host, 'fixture-a')
  const first = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  const body =
    '{ "error": { "metadata": { "limit_source": "openrouter_key_limit" } } }'
  const response = await answer(
    host,
    first,
    new Response(body, { status: 402 }),
  )
  expect(response.status).toBe(402)
  expect(await response.text()).toBe(body)
  const retry = await trigger(host, 'retry', {
    sessionID: first.scope.sessionID,
    agent: first.scope.agent,
    model: first.scope.model,
    error: { type: 'provider.error', message: 'cap', status: 402 },
    attempt: 1,
    decision: { retry: false } as
      | { retry: true; delay: number }
      | { retry: false },
  })
  expect(retry.decision).toEqual({ retry: false })
  await send(host, 'fixture-a', post(`${origin}/v1`, bearer('fixture-a')))
  expect(vault.reads).toEqual(['a1', 'a1'])
  expect(vault.reports).toEqual([])
})

test('OpenRouter confirmed balance 402 HTTP moves to the next account', async () => {
  const { host, vault } = await startServer({
    table: table.map((entry) => ({ ...entry, service: 'openrouter' })),
    rows: [row('a1'), row('a2')],
  })
  await login(host, 'fixture-a')
  const first = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  await answer(
    host,
    first,
    Response.json(
      {
        error: { metadata: { limit_source: 'openrouter_credits' } },
      },
      { status: 402 },
    ),
  )
  const retry = await trigger(host, 'retry', {
    sessionID: first.scope.sessionID,
    agent: first.scope.agent,
    model: first.scope.model,
    error: { type: 'provider.error', message: 'balance', status: 402 },
    attempt: 1,
    decision: { retry: false } as
      | { retry: true; delay: number }
      | { retry: false },
  })
  expect(retry.decision).toEqual({ retry: true, delay: 0 })
  await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
    first.scope,
  )
  expect(vault.reads).toEqual(['a1', 'a2'])
  expect(vault.reports).toEqual([])
})

test('xAI 402 error frames never create a balance or rate limit', () => {
  for (const code of ['payment_required', 'rate_limit_exceeded'])
    expect(
      inspectResponsesFrame(
        JSON.stringify({ type: 'error', status: 402, error: { code } }),
        {},
        'xai',
      )?.limit,
    ).toBeUndefined()
})

test('402 WebSocket error frames return a payment-required limit without a vault report', async () => {
  expect(
    inspectResponsesFrame(
      '{"type":"error","status":402,"error":{"message":"insufficient balance"}}',
      {},
      'deepseek',
    ),
  ).toMatchObject({ limit: { reason: 'payment-required', status: 402 } })
  const { host, vault } = await startServer({
    table: socketTable.map((entry) => ({ ...entry, service: 'deepseek' })),
    rows: [row('a1'), row('a2')],
  })
  await login(host, 'fixture-a')
  const first = scope('fixture-a')
  await handshake(host, 'fixture-a', socketURL, first)
  await receive(host, first, '{"type":"error","status":402}')
  await handshake(host, 'fixture-a', socketURL, scope('fixture-a'))
  expect(vault.reads).toEqual(['a1', 'a2'])
  expect(vault.reports).toEqual([])
})

test('a 429 marks the account and the retry hook moves the turn to the next one', async () => {
  const rows = [row('a1'), row('a2')]
  const { host, vault } = await startServer({ rows })
  await login(host, 'fixture-a')
  const first = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  expect(first.request.headers.get('authorization')).toBe('Bearer secret-a1-1')
  await answer(
    host,
    first,
    new Response('{"error":"rate"}', {
      status: 429,
      headers: { 'retry-after': '120' },
    }),
  )
  const retry = await trigger(host, 'retry', {
    sessionID: first.scope.sessionID,
    agent: first.scope.agent,
    model: first.scope.model,
    error: { type: 'provider.rate-limit', message: 'rate', status: 429 },
    attempt: 1,
    decision: { retry: true, delay: 120_000 } as
      | { retry: true; delay: number }
      | { retry: false },
  })
  expect(retry.decision).toEqual({ retry: true, delay: 0 })
  const second = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
    first.scope,
  )
  expect(second.request.headers.get('authorization')).toBe('Bearer secret-a2-1')
  // A new session also avoids the marked account until its mark ends.
  const fresh = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  expect(fresh.request.headers.get('authorization')).toBe('Bearer secret-a2-1')
  expect(vault.reads).toEqual(['a1', 'a2', 'a2'])
})

test('a 401 is reported once, for the receipt this request was served, with its record version', async () => {
  const rows = [row('a1')]
  const { host, vault } = await startServer({ rows })
  await login(host, 'fixture-a')
  vault.version = 7
  const sent = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  await answer(host, sent, new Response('no', { status: 401 }))
  await Bun.sleep(10)
  expect(vault.reports).toEqual([
    expect.objectContaining({ credentialId: 'a1', recordVersion: 7 }),
  ])
  // A 403 or a 500 is never reported.
  for (const status of [403, 500]) {
    const other = await send(
      host,
      'fixture-a',
      post(`${origin}/v1`, bearer('fixture-a')),
    )
    await answer(host, other, new Response('no', { status }))
  }
  await Bun.sleep(10)
  expect(vault.reports).toHaveLength(1)
})

test('the served secret is redacted from error bodies, SSE error events and response headers', async () => {
  const { host } = await startServer()
  await login(host, 'fixture-a')
  const secret = 'secret-a1-1'
  const error = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  const body = await answer(
    host,
    error,
    Response.json(
      { error: { message: `bad key ${secret}` } },
      { status: 400, headers: { 'x-echo': secret } },
    ),
  )
  const text = await body.text()
  expect(text).not.toContain(secret)
  expect(text).toContain('bad key')
  expect(body.headers.get('x-echo')).not.toContain(secret)
  const stream = await send(
    host,
    'fixture-a',
    post(`${origin}/v1`, bearer('fixture-a')),
  )
  const events = await answer(
    host,
    stream,
    new Response(
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\nevent: error\ndata: {"error":{"message":"leaked ${secret}"}}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  )
  const streamed = await events.text()
  expect(streamed).toContain('"content":"hi"')
  expect(streamed).not.toContain(secret)
})

test('rows vanishing while owned refuse locally and send nothing', async () => {
  const { host, vault } = await startServer()
  await login(host, 'fixture-a')
  vault.rows = []
  await login(host, 'fixture-b').catch(() => {})
  await expect(
    send(host, 'fixture-a', post(`${origin}/v1`, bearer('fixture-a'))),
  ).rejects.toThrow('no vault account for fixture-a')
  expect(vault.reads).toEqual([])
  // Two sign-ins and a roster change, each writing owner-only files for real:
  // on Windows that takes the access-list path and runs past Bun's 5 s default.
}, 20_000)

test('a request refused for want of an account says vault mode is off when it is', async () => {
  // Once vault mode goes off, the hub empties every roster at its next
  // authority read. Here the roster is emptied first and the mode switched
  // after, the order a request can meet between two hub ticks.
  const { host, vault } = await startServer()
  await login(host, 'fixture-a')
  vault.rows = []
  await login(host, 'fixture-b').catch(() => {})
  vault.mode = 'local'
  await expect(
    send(host, 'fixture-a', post(`${origin}/v1`, bearer('fixture-a'))),
  ).rejects.toThrow('vault mode is off')
  expect(vault.reads).toEqual([])
}, 20_000)

// WebSocket handshakes: fixture-a may be sent over a socket to
// wss://fixture.invalid; the other fixtures have no handshake origin.
const socketTable = table.map((entry) =>
  entry.service === 'fixture-a'
    ? { ...entry, handshakeOrigins: ['wss://fixture.invalid'] }
    : entry,
)
const socketURL = 'wss://fixture.invalid/v1/responses'

function handshake(
  host: FakeHost,
  provider: string,
  url: string,
  s = scope(provider),
  headers: Record<string, string> = bearer(provider),
) {
  return trigger(host, 'experimental.ws.handshake', {
    ...s,
    url,
    headers: { ...headers },
  })
}

function receive(host: FakeHost, s: ReturnType<typeof scope>, frame: string) {
  return trigger(host, 'experimental.ws.receive', { ...s, frame })
}

test('an owned handshake is served in order: origin, authorize, Authorization; error frames reach the host without the key', async () => {
  const { host, vault } = await startServer({ table: socketTable })
  await login(host, 'fixture-a')
  const s = scope('fixture-a')
  const draft = await handshake(host, 'fixture-a', socketURL, s, {
    ...bearer('fixture-a'),
    'x-extra': 'kept',
  })
  expect(draft.url).toBe(socketURL)
  expect(draft.headers).toEqual({
    authorization: 'Bearer secret-a1-1',
    'x-extra': 'kept',
  })
  expect(vault.reads).toEqual(['a1'])
  const echoed = await receive(
    host,
    s,
    JSON.stringify({
      type: 'error',
      status: 400,
      error: { message: 'bad key secret-a1-1' },
    }),
  )
  expect(echoed.frame).toContain('bad key')
  expect(echoed.frame).not.toContain('secret-a1-1')
  const delta = '{"type":"response.output_text.delta","delta":"hi"}'
  expect((await receive(host, s, delta)).frame).toBe(delta)
})

test('a handshake to another origin, or for a provider without handshake origins, is refused before any vault read', async () => {
  const { host, vault } = await startServer({
    table: socketTable,
    rows: [row('a1'), row('b1', { providerIds: ['fixture-b'] })],
  })
  await login(host, 'fixture-a')
  await login(host, 'fixture-b')
  for (const url of [
    'wss://elsewhere.invalid/v1/responses',
    'ws://fixture.invalid/v1/responses',
    'wss://fixture.invalid:444/v1/responses',
    'https://fixture.invalid/v1/responses',
    'wss://user:pass@fixture.invalid/v1/responses',
  ])
    await expect(handshake(host, 'fixture-a', url)).rejects.toThrow(
      'the vault key for fixture-a is only sent over WebSocket to wss://fixture.invalid',
    )
  await expect(
    handshake(host, 'fixture-b', 'wss://fixture.invalid/v1'),
  ).rejects.toThrow('the vault key for fixture-b is never sent over WebSocket')
  expect(vault.reads).toEqual([])
  // A handshake that passed the origin check but was refused afterwards
  // (here: the placeholder in a second header) leaves nothing an HTTP
  // request of the same session could use to read before its own check.
  const s = scope('fixture-a')
  await expect(
    handshake(host, 'fixture-a', socketURL, s, {
      ...bearer('fixture-a'),
      'x-api-key': placeholderSecret('fixture-a'),
    }),
  ).rejects.toThrow('more than one header')
  await expect(
    send(
      host,
      'fixture-a',
      post('https://elsewhere.invalid/v1', bearer('fixture-a')),
      s,
    ),
  ).rejects.toThrow('is only sent to')
  expect(vault.reads).toEqual([])
  // A foreign handshake passes untouched.
  const foreign = await handshake(
    host,
    'fixture-a',
    'wss://elsewhere.invalid/v1',
    scope('fixture-a'),
    { authorization: 'Bearer user-key' },
  )
  expect(foreign.headers).toEqual({ authorization: 'Bearer user-key' })
  expect(vault.reads).toEqual([])
})

test('a handshake URL moved after the origin check is refused, and the key never enters the handshake', async () => {
  const clock = phaseClock('moved handshake URL test')
  const { host, vault } = await startServer({ table: socketTable, clock })
  await login(host, 'fixture-a')
  clock.mark('login')
  // Another plugin's hook between the plugin's check and the installer.
  const hooks = host.hooks.get('experimental.ws.handshake') ?? []
  const draft = {
    ...scope('fixture-a'),
    url: socketURL,
    headers: bearer('fixture-a') as Record<string, string>,
  }
  hooks.splice(1, 0, {
    callback: ((moved: typeof draft) => {
      moved.url = 'wss://elsewhere.invalid/v1/responses'
    }) as never,
    providerID: 'fixture-a',
  })
  await expect(
    trigger(host, 'experimental.ws.handshake', draft),
  ).rejects.toThrow('is only sent over WebSocket to wss://fixture.invalid')
  clock.mark('refused handshake')
  expect(draft.headers.authorization).toBe(
    `Bearer ${placeholderSecret('fixture-a')}`,
  )
  // The read already happened for the URL that was checked.
  expect(vault.reads).toEqual(['a1'])
  clock.done()
})

test('WebSocket output markers exclude only envelope and error frames', () => {
  for (const type of [
    'response.created',
    'response.in_progress',
    'codex.rate_limits',
    'codex.future_event',
  ])
    expect(inspectResponsesFrame(JSON.stringify({ type }), undefined)).toBe(
      undefined,
    )
  for (const type of ['error', 'response.failed'])
    expect(
      inspectResponsesFrame(JSON.stringify({ type, status: 429 }), undefined),
    ).toEqual({
      error: 'the provider answered with an error frame',
      limit: { reason: 'rate-limit', status: 429 },
    })
  for (const type of [
    'response.output_item.added',
    'response.output_text.done',
    'response.reasoning_text.done',
    'response.function_call_arguments.done',
    'response.output_text.delta',
    'response.completed',
    'response.incomplete',
    'future.output',
  ])
    expect(
      inspectResponsesFrame(JSON.stringify({ type }), undefined)?.outputStarted,
    ).toBe(true)
  for (const frame of ['{}', 'null', 'not JSON'])
    expect(inspectResponsesFrame(frame, undefined)?.outputStarted).toBe(true)
})

for (const status of [402, 429]) {
  test(`done-only WebSocket output prevents a ${status} retry from moving to another account`, async () => {
    const { host, vault } = await startServer({
      table:
        status === 402
          ? socketTable.map((entry) => ({ ...entry, service: 'deepseek' }))
          : socketTable,
      rows: [row('a1'), row('a2')],
    })
    await login(host, 'fixture-a')
    const s = scope('fixture-a')
    const opened = await handshake(host, 'fixture-a', socketURL, s)
    expect(opened.headers.authorization).toBe('Bearer secret-a1-1')
    for (const frame of [
      { type: 'response.created', response: { id: 'resp_1' } },
      {
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_1' },
      },
      {
        type: 'response.output_text.done',
        item_id: 'msg_1',
        text: 'Already produced',
      },
      {
        type: 'error',
        status,
        error: {
          code: status === 402 ? 'payment_required' : 'rate_limit_exceeded',
          message: 'refused',
        },
      },
    ])
      await receive(host, s, JSON.stringify(frame))
    const retry = await trigger(host, 'retry', {
      sessionID: s.sessionID,
      agent: s.agent,
      model: s.model,
      error: { type: 'provider.error', message: 'refused', status },
      attempt: 1,
      decision: { retry: true, delay: 120_000 } as
        | { retry: true; delay: number }
        | { retry: false },
    })
    expect(retry.decision).toEqual({ retry: false })
    expect(vault.reads).toEqual(['a1'])
  })
}

test('a 429 error frame marks the account and the next handshake goes to the next one; a 401 error frame is reported once', async () => {
  const clock = phaseClock('error frame test')
  const { host, vault } = await startServer({
    table: socketTable,
    rows: [row('a1'), row('a2')],
    clock,
  })
  await login(host, 'fixture-a')
  clock.mark('login')
  vault.version = 5
  const first = scope('fixture-a')
  const opened = await handshake(host, 'fixture-a', socketURL, first)
  clock.mark('first handshake')
  expect(opened.headers.authorization).toBe('Bearer secret-a1-5')
  await receive(
    host,
    first,
    '{"type":"error","status":429,"error":{"code":"rate_limit_exceeded","message":"slow down"}}',
  )
  await Bun.sleep(10)
  const second = scope('fixture-a')
  const moved = await handshake(host, 'fixture-a', socketURL, second)
  clock.mark('429 frame and second handshake')
  expect(moved.headers.authorization).toBe('Bearer secret-a2-5')
  await receive(
    host,
    second,
    '{"type":"error","status":401,"error":{"message":"bad key"}}',
  )
  await Bun.sleep(10)
  clock.mark('401 frame and report')
  expect(vault.reports).toEqual([
    expect.objectContaining({ credentialId: 'a2', recordVersion: 5 }),
  ])
  clock.done()
})
