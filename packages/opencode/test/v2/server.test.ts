import { expect, test } from 'bun:test'
import { ClaustrumConsumerError } from '@cortexkit/common-auth/claustrum'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
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
