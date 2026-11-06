import { afterAll, expect, test } from 'bun:test'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { withTestTiming } from '../../../core/test/phase-timing.ts'
import { type ServerDeps, vaultMethodId } from '../../src/v2/setup.ts'
import { origin, row, scope, startServer, table, trigger } from './fakes.ts'

// The installed coordinator receives HTTP responses and WS frames. None of
// these tests supplies a preclassified limit to the adapter or decision layer.
const covered = new Set<number>()
const ids = [
  3, 8, 9, 11, 16, 17, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 41, 58, 59,
  67, 68, 69,
]
function vector(id: number, name: string, check: () => Promise<void>) {
  test(`CL-${id} ${name}`, () =>
    withTestTiming(`opencode2 CL-${id} ${name}`, async () => {
      await check()
      covered.add(id)
    }))
}
afterAll(() => expect([...covered].sort((a, b) => a - b)).toEqual(ids))
const provider = 'fixture-a'
const owned = { authorization: `Bearer ${placeholderSecret(provider)}` }
const socketURL = 'wss://fixture.invalid/v1/responses'
const rateFrame =
  '{"type":"error","status":429,"error":{"code":"rate_limit_exceeded","message":"limited"}}'
const balanceFrame =
  '{"type":"error","status":402,"retry_after":7200,"error":{"code":"payment_required","message":"Insufficient Balance"}}'

async function world(
  options: {
    count?: number
    service?: string
    tickOnLimit?: number
    observe?: ServerDeps['observe']
  } = {},
) {
  let time = 1000
  const limitsSeen: {
    status?: number
    retryAfterMs?: number
    reason: string
  }[] = []
  const selected: string[] = []
  const server = await startServer({
    now: () => time,
    rows: Array.from({ length: options.count ?? 2 }, (_, i) =>
      row(`a${i + 1}`),
    ),
    table: table.map((entry) =>
      entry.service === provider
        ? {
            ...entry,
            service: options.service ?? provider,
            handshakeOrigins: ['wss://fixture.invalid'],
          }
        : entry,
    ),
    observe(id, installation) {
      if (id === provider) {
        installation.on('limit', (event) => {
          limitsSeen.push(event.limit)
          if (options.tickOnLimit !== undefined) time = options.tickOnLimit
        })
        installation.on('select', (event) => {
          selected.push(event.accountId)
        })
      }
      options.observe?.(id, installation)
    },
  })
  const method = server.host.methods.get(`${provider}:${vaultMethodId}`)
  if (!method) throw new Error('Expected vault login method')
  await (await method.authorize({})).callback
  const limits = async () => {
    const core = server.lastCore()
    if (!core) throw new Error('Expected active core')
    return core.limits(provider)
  }
  return {
    ...server,
    limitsSeen,
    selected,
    limits,
    setTime(value: number) {
      time = value
    },
    async http(
      s = scope(provider),
      foreign = false,
      url = `${origin}/v1`,
      redirect: RequestRedirect = 'manual',
    ) {
      const request = new Request(url, {
        method: 'POST',
        body: '{}',
        redirect,
        headers: foreign ? { authorization: 'Bearer user-key' } : owned,
      })
      const sent = await trigger(server.host, 'http.request', { ...s, request })
      return { s, request: sent.request }
    },
    async answer(
      sent: { s: ReturnType<typeof scope>; request: Request },
      response: Response,
    ) {
      return (
        await trigger(server.host, 'http.response', {
          ...sent.s,
          request: sent.request,
          response,
        })
      ).response
    },
    ws(s = scope(provider), headers = owned, url = socketURL) {
      return trigger(server.host, 'experimental.ws.handshake', {
        ...s,
        url,
        headers: { ...headers },
      })
    },
    frame(s: ReturnType<typeof scope>, frame: string) {
      return trigger(server.host, 'experimental.ws.receive', { ...s, frame })
    },
    async retry(
      s: ReturnType<typeof scope>,
      status = 429,
      decision: { retry: true; delay: number } | { retry: false } = {
        retry: true,
        delay: 2000,
      },
      attempt = 1,
    ) {
      return (
        await trigger(server.host, 'retry', {
          sessionID: s.sessionID,
          agent: s.agent,
          model: s.model,
          error: { type: 'provider.error', message: 'refused', status },
          attempt,
          decision,
        })
      ).decision
    },
    async blockers() {
      return (await (await limits()).candidates())[0].blockers
    },
  }
}
function reply(status = 429, hint?: string) {
  return new Response('{"error":{"message":"provider refusal"}}', {
    status,
    headers: hint === undefined ? {} : { 'retry-after': hint },
  })
}
async function limited(
  w: Awaited<ReturnType<typeof world>>,
  status = 429,
  hint?: string,
) {
  const sent = await w.http()
  await w.answer(sent, reply(status, hint))
  await w.retry(sent.s, status)
  return sent
}

vector(
  3,
  'HTTP-date hint uses classifier delay at the later mark-event clock',
  async () => {
    const w = await world({ tickOnLimit: 1250 })
    await limited(w, 429, 'Thu, 01 Jan 1970 00:00:18 GMT')
    expect(w.limitsSeen).toEqual([
      { reason: 'rate-limit', status: 429, retryAfterMs: 17000 },
    ])
    expect(await w.blockers()).toMatchObject([
      { until: 18250, cause: 'rate-limit' },
    ])
  },
)
for (const id of [8, 9])
  vector(
    id,
    'WS rate-limit parser ignores wire retry and reset hints',
    async () => {
      const w = await world()
      const s = scope(provider)
      await w.ws(s)
      await w.frame(
        s,
        id === 8
          ? rateFrame
          : '{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","retry_after":7200,"reset_at":999999}}}',
      )
      expect(await w.retry(s)).toEqual({ retry: true, delay: 0 })
      expect(w.limitsSeen).toEqual([{ reason: 'rate-limit', status: 429 }])
      expect(await w.blockers()).toEqual([
        { kind: 'hard', until: 61000, cause: 'rate-limit' },
      ])
    },
  )
vector(
  11,
  'new HTTP limits overwrite longer deadlines, including zero and absent hints',
  async () => {
    for (const [hint, until] of [
      ['17', 18000],
      ['0', undefined],
      [undefined, 61000],
    ] as const) {
      const w = await world({ count: 1 })
      await limited(w, 429, '120')
      await limited(w, 429, hint)
      expect((await w.blockers())[0]?.until).toBe(until)
    }
  },
)
vector(
  16,
  'HTTP account marks cover another model and WS transport',
  async () => {
    const w = await world()
    await limited(w, 429, '120')
    const other = scope(provider)
    other.model.id = 'another-model'
    const socket = await w.ws(other)
    expect(socket.headers.authorization).toBe('Bearer secret-a2-1')
    expect(w.vault.reads).toEqual(['a1', 'a2'])
  },
)
vector(
  17,
  'retry joins delayed feedback and duplicate replies produce one mark operation',
  async () => {
    let release = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = await world({
      observe(id, installation) {
        if (id === provider) installation.on('limit', () => barrier)
      },
    })
    const sent = await w.http()
    await w.answer(sent, reply(429, '17'))
    await w.answer(sent, reply(429, '17'))
    let finished = false
    const retry = w.retry(sent.s).then((decision) => {
      finished = true
      return decision
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(w.vault.reads).toEqual(['a1'])
    release()
    expect(await retry).toEqual({ retry: true, delay: 0 })
    expect(w.limitsSeen).toHaveLength(1)
    await (await w.limits()).flush()
    const core = w.lastCore()
    if (!core) throw new Error('Expected core')
    const saved = await readVaultRoster(core.hub.rosterPath(provider))
    expect(saved?.limits).toMatchObject({ operationIds: [expect.any(Object)] })
  },
)
vector(
  28,
  'retry queues B at zero delay and consumes the choice once',
  async () => {
    const w = await world()
    const first = await w.http()
    await w.answer(first, reply(429, '120'))
    expect(await w.retry(first.s, 429, { retry: false })).toEqual({
      retry: true,
      delay: 0,
    })
    expect((await w.http(first.s)).request.headers.get('authorization')).toBe(
      'Bearer secret-a2-1',
    )
    expect(w.vault.reads).toEqual(['a1', 'a2'])
  },
)
vector(
  29,
  'exhausted retry preserves the incoming host delay and queues no account',
  async () => {
    const w = await world({ count: 1 })
    const sent = await w.http()
    await w.answer(sent, reply(429, '120'))
    expect(await w.retry(sent.s)).toEqual({ retry: true, delay: 2000 })
    expect(w.vault.reads).toEqual(['a1'])
  },
)
vector(
  30,
  'fresh request escapes an all-marked pool without waiting',
  async () => {
    const w = await world({ count: 1 })
    await limited(w, 429, '120')
    expect((await w.http()).request.headers.get('authorization')).toBe(
      'Bearer secret-a1-1',
    )
    expect(w.vault.reads).toEqual(['a1', 'a1'])
  },
)

async function socketLimit(
  frames: readonly string[],
  status = 429,
  service = provider,
) {
  const w = await world({ service })
  const s = scope(provider)
  await w.ws(s)
  for (const frame of frames) await w.frame(s, frame)
  await w.frame(s, status === 402 ? balanceFrame : rateFrame)
  return { w, s, decision: await w.retry(s, status) }
}
vector(31, 'done-only output vetoes replay without a text delta', async () => {
  const { w, decision } = await socketLimit([
    '{"type":"response.output_item.added"}',
    '{"type":"response.output_text.done"}',
  ])
  expect(decision).toEqual({ retry: false })
  expect(w.vault.reads).toEqual(['a1'])
})
vector(
  32,
  'lifecycle envelopes do not veto but completed and incomplete output do',
  async () => {
    for (const type of [
      'response.created',
      'response.in_progress',
      'codex.rate_limits',
    ]) {
      const { decision } = await socketLimit([JSON.stringify({ type })])
      expect(decision).toEqual({ retry: true, delay: 0 })
    }
    for (const type of ['response.completed', 'response.incomplete']) {
      const { decision } = await socketLimit([JSON.stringify({ type })])
      expect(decision).toEqual({ retry: false })
    }
  },
)
vector(
  33,
  'unknown empty non-object and malformed WS frames conservatively veto',
  async () => {
    for (const frame of ['{"type":"future"}', '{}', 'null', 'not JSON']) {
      const { w, decision } = await socketLimit([frame])
      expect(decision).toEqual({ retry: false })
      expect(w.vault.reads).toEqual(['a1'])
    }
  },
)
vector(
  34,
  'HTTP 200 SSE text is not inferred to be an account limit',
  async () => {
    const w = await world()
    const sent = await w.http()
    const response = await w.answer(
      sent,
      new Response('data: {"type":"error","status":429}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    expect(await response.text()).toContain('429')
    expect(await w.retry(sent.s)).toEqual({ retry: true, delay: 2000 })
    expect(w.limitsSeen).toEqual([])
    expect(await w.blockers()).toEqual([])
    expect(w.vault.reads).toEqual(['a1'])
  },
)
vector(
  35,
  'a mixed-ownership session stays tainted after an owned limit',
  async () => {
    const w = await world()
    const s = scope(provider)
    await w.http(s, true)
    const sent = await w.http(s)
    await w.answer(sent, reply(429, '17'))
    expect(await w.retry(s)).toEqual({ retry: true, delay: 2000 })
    expect(w.limitsSeen).toHaveLength(1)
    expect(w.vault.reads).toEqual(['a1'])
  },
)
vector(
  36,
  'foreign and ambiguously attributed retries never choose an arbitrary account',
  async () => {
    const foreign = await world()
    const sent = await foreign.http(undefined, true)
    await foreign.answer(sent, reply(429))
    expect(await foreign.retry(sent.s)).toEqual({ retry: true, delay: 2000 })
    expect(foreign.vault.reads).toEqual([])
    expect(foreign.limitsSeen).toEqual([])
    const w = await world()
    const s = scope(provider)
    const first = await trigger(w.host, 'model.request', {
      ...s,
      headers: {} as Record<string, string>,
    })
    const second = await trigger(w.host, 'model.request', {
      ...s,
      headers: {} as Record<string, string>,
    })
    const send = async (carried: Record<string, string>) => ({
      s,
      request: (
        await trigger(w.host, 'http.request', {
          ...s,
          request: new Request(`${origin}/v1`, {
            method: 'POST',
            body: '{}',
            headers: { ...carried, ...owned },
          }),
        })
      ).request,
    })
    const two = await send(second.headers)
    const one = await send(first.headers)
    expect(await w.retry(s)).toEqual({ retry: true, delay: 2000 })
    expect(w.limitsSeen).toHaveLength(0)
    // Once a reply identifies a failed attempt, retry may safely reroute it.
    await w.answer(two, reply(429, '17'))
    expect(await w.retry(s)).toEqual({ retry: true, delay: 0 })
    await (await w.answer(one, new Response('still open'))).text()
    expect(w.limitsSeen).toHaveLength(1)
    expect(w.vault.reads).toEqual(['a1', 'a1'])
  },
)
vector(
  37,
  'an unsignalled HTTP 401 reports auth but leaves host retry unchanged',
  async () => {
    const w = await world()
    const sent = await w.http()
    await w.answer(sent, reply(401))
    expect(await w.retry(sent.s, 401)).toEqual({ retry: true, delay: 2000 })
    expect(w.vault.reports).toHaveLength(1)
    expect(w.vault.reads).toEqual(['a1'])
    expect(w.limitsSeen).toEqual([])
    expect(await w.blockers()).toEqual([])
  },
)
vector(38, 'HTTP and WS origins are checked before serving a key', async () => {
  const w = await world()
  await expect(
    w.http(undefined, false, 'https://elsewhere.invalid/v1'),
  ).rejects.toThrow('is only sent to')
  await expect(
    w.ws(undefined, owned, 'wss://fixture.invalid:444/v1'),
  ).rejects.toThrow('is only sent over WebSocket')
  expect(w.vault.reads).toEqual([])
  expect(w.limitsSeen).toEqual([])
})
vector(
  41,
  'HTTP redirect delivery is not a plugin-owned quota or redirect loop',
  async () => {
    const w = await world()
    const sent = await w.http(undefined, false, `${origin}/v1`, 'follow')
    expect(sent.request.redirect).toBe('follow')
    const response = await w.answer(
      sent,
      new Response(null, { status: 307, headers: { location: '/next' } }),
    )
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('/next')
    expect(w.limitsSeen).toEqual([])
    expect(w.vault.reads).toEqual(['a1'])
  },
)
vector(
  58,
  'payment bridge preserves reason and event-relative Retry-After',
  async () => {
    const w = await world({ service: 'deepseek', tickOnLimit: 1250 })
    const first = await limited(w, 402, '17')
    expect(w.limitsSeen).toEqual([
      { reason: 'payment-required', status: 402, retryAfterMs: 17000 },
    ])
    expect(await w.blockers()).toEqual([
      { kind: 'hard', until: 18250, cause: 'payment-balance' },
    ])
    expect((await w.http(first.s)).request.headers.get('authorization')).toBe(
      'Bearer secret-a2-1',
    )
    expect(w.vault.reports).toEqual([])
  },
)
vector(
  59,
  'fresh requests probe a balance-marked account while exhausted retries leave host policy',
  async () => {
    const w = await world({ service: 'deepseek', count: 1 })
    const first = await w.http()
    await w.answer(first, reply(402))
    expect(await w.retry(first.s, 402)).toEqual({ retry: true, delay: 2000 })
    expect(
      await w.retry(first.s, 402, { retry: true, delay: 2000 }, 4),
    ).toEqual({ retry: true, delay: 2000 })
    expect((await w.http()).request.headers.get('authorization')).toBe(
      'Bearer secret-a1-1',
    )
    expect(w.vault.reads).toEqual(['a1', 'a1'])
  },
)
vector(
  67,
  'a parsed balance frame marks five minutes without accepting frame reset hints',
  async () => {
    const { w, decision } = await socketLimit(
      ['{"type":"response.created"}'],
      402,
      'deepseek',
    )
    expect(decision).toEqual({ retry: true, delay: 0 })
    expect(w.limitsSeen).toEqual([{ reason: 'payment-required', status: 402 }])
    expect(await w.blockers()).toEqual([
      { kind: 'hard', until: 301000, cause: 'payment-balance' },
    ])
    expect(w.vault.reports).toEqual([])
  },
)
vector(
  68,
  'payment after done-only output remains marked but replay is vetoed',
  async () => {
    const { w, decision } = await socketLimit(
      ['{"type":"response.output_text.done"}'],
      402,
      'deepseek',
    )
    expect(decision).toEqual({ retry: false })
    expect(await w.blockers()).toEqual([
      { kind: 'hard', until: 301000, cause: 'payment-balance' },
    ])
    expect(w.vault.reads).toEqual(['a1'])
    expect(w.vault.reports).toEqual([])
  },
)
vector(
  69,
  'xAI 402 frames do not create a balance signal or quota reroute',
  async () => {
    const { w, decision } = await socketLimit([], 402, 'xai')
    expect(decision).toEqual({ retry: true, delay: 2000 })
    expect(w.limitsSeen).toEqual([])
    expect(await w.blockers()).toEqual([])
    expect(w.vault.reads).toEqual(['a1'])
  },
)
