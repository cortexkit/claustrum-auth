// A loopback stand-in for an OpenAI-compatible chat provider, speaking just
// enough streamed `/chat/completions` for one OpenCode 2 turn, plus a second
// origin (another port is another origin) that answers every request. Both
// record every request they receive, headers included, so a test can check
// exactly what reached the wire. Values recorded here are loopback test
// credentials served by the fake vault, never production secrets.
import { createServer, type Socket } from 'node:net'

export interface WireRecord {
  readonly server: 'mock' | 'other'
  readonly method: string
  readonly path: string
  /**
   * `handshake`: a WebSocket upgrade request. A `response.create` message on
   * a socket is recorded as `primary` or `title` with `transport: 'ws'`.
   */
  readonly kind: 'primary' | 'title' | 'other' | 'handshake'
  readonly authorization: string | null
  readonly headers: readonly [string, string][]
  readonly behavior?: string
  /** `ws` for a message received on a socket; absent for HTTP. */
  readonly transport?: 'ws'
  /** The socket a handshake opened or a message arrived on. */
  readonly socket?: number
}

/** What the mock does with the next agent-loop request. */
export type Behavior =
  | { type: 'ok' }
  | {
      type: 'status'
      status: number
      body?: string
      headers?: Record<string, string>
    }
  /** A 400 whose body and `x-echo` header repeat the bearer it received. */
  | { type: 'echo-error' }
  /** A 200 stream whose error event repeats the bearer it received. */
  | { type: 'echo-sse' }
  /** A redirect to `location(bearer)`, built from the bearer it received. */
  | { type: 'redirect'; status: number; location: (bearer: string) => string }

/** What the mock does with the next WebSocket upgrade request. */
export type HandshakeBehavior =
  | { type: 'accept' }
  /** Refuses the upgrade with this status. */
  | { type: 'status'; status: number }
  /** Answers the upgrade with a redirect to `location(bearer)`. */
  | { type: 'redirect'; status: number; location: (bearer: string) => string }

/** What the mock sends back for the next agent-loop `response.create`. */
export type FrameBehavior =
  | { type: 'ok' }
  /** An error frame carrying this provider status. */
  | { type: 'status'; status: number }
  /** An error frame whose message repeats the bearer of its handshake. */
  | { type: 'echo-error' }

/** The Responses events of one short completed reply, as WebSocket frames. */
export function responsesFrames(text: string, id: string) {
  const item = (status: string, content: object[]) => ({
    type: 'message',
    id: `msg_${id}`,
    role: 'assistant',
    status,
    content,
  })
  const done = item('completed', [
    { type: 'output_text', text, annotations: [] },
  ])
  return [
    { type: 'response.created', response: { id: `resp_${id}` } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: item('in_progress', []),
    },
    {
      type: 'response.output_text.delta',
      item_id: `msg_${id}`,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: 'response.output_item.done', output_index: 0, item: done },
    {
      type: 'response.completed',
      response: {
        id: `resp_${id}`,
        status: 'completed',
        output: [done],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    },
  ].map((event) => JSON.stringify(event))
}

function errorFrame(status: number, message: string) {
  return JSON.stringify({
    type: 'error',
    status,
    error: {
      type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
      code: status === 429 ? 'rate_limit_exceeded' : `status_${status}`,
      message,
    },
  })
}

const chunk = (content: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        delta: finish ? {} : { role: 'assistant', content },
        finish_reason: finish,
      },
    ],
    ...(finish
      ? { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
      : {}),
  })}\n\n`

export function completion(text: string) {
  return new Response(
    `${chunk(text, null)}${chunk('', 'stop')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

const bearerOf = (headers: Headers) =>
  /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '')?.[1] ?? ''

export interface MockProvider {
  readonly url: string
  readonly otherURL: string
  /**
   * An origin that accepts a connection, reads the request line and closes
   * the connection unanswered: the host's client fails with a transport
   * error after following a redirect there.
   */
  readonly resetURL: string
  /** Request lines the reset origin read, with any bearer value removed. */
  readonly resets: string[]
  readonly records: WireRecord[]
  /** Queues what the next agent-loop requests get, in order. */
  next(...behaviors: Behavior[]): void
  /** Queues what the next WebSocket upgrades of the mock origin get. */
  nextHandshake(...behaviors: HandshakeBehavior[]): void
  /** Queues what the next agent-loop messages on a socket get. */
  nextFrame(...behaviors: FrameBehavior[]): void
  /** Drops every queued behavior. */
  clear(): void
  /** Resolves once `count` agent-loop requests have arrived. */
  waitForPrimaries(count: number, ms?: number): Promise<boolean>
  stop(): Promise<void>
}

interface SocketData {
  server: WireRecord['server']
  socket: number
  path: string
  authorization: string | null
  headers: [string, string][]
}

const sse = (frames: string[]) =>
  new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

export async function startMockProvider(): Promise<MockProvider> {
  const records: WireRecord[] = []
  const queue: Behavior[] = []
  const handshakes: HandshakeBehavior[] = []
  const frames: FrameBehavior[] = []
  let replies = 0
  let socketCount = 0
  const isResponses = (path: string) => path.endsWith('/responses')
  const record = async (server: WireRecord['server'], request: Request) => {
    const body = request.method === 'GET' ? '' : await request.text()
    const path = new URL(request.url).pathname
    const upgrade =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const kind: WireRecord['kind'] = upgrade
      ? 'handshake'
      : !path.endsWith('chat/completions') && !isResponses(path)
        ? 'other'
        : /"tools"\s*:/.test(body)
          ? 'primary'
          : 'title'
    return {
      server,
      method: request.method,
      path,
      kind,
      authorization: request.headers.get('authorization'),
      headers: [...request.headers],
    }
  }
  // Both origins speak the Responses socket: the second one too, so a test
  // can show that a handshake which does reach it is recorded with its key.
  const websocket = {
    message(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) {
      const text = String(message)
      let type: unknown
      try {
        type = (JSON.parse(text) as { type?: unknown }).type
      } catch {}
      if (type !== 'response.create') return
      const kind = /"tools"\s*:/.test(text) ? 'primary' : 'title'
      const behavior: FrameBehavior =
        kind === 'primary' && ws.data.server === 'mock'
          ? (frames.shift() ?? { type: 'ok' })
          : { type: 'ok' }
      records.push({
        server: ws.data.server,
        method: 'MESSAGE',
        path: ws.data.path,
        kind,
        authorization: ws.data.authorization,
        headers: ws.data.headers,
        behavior: behavior.type,
        transport: 'ws',
        socket: ws.data.socket,
      })
      const bearer =
        /^Bearer (.+)$/i.exec(ws.data.authorization ?? '')?.[1] ?? ''
      const out =
        behavior.type === 'status'
          ? [errorFrame(behavior.status, 'mock refusal')]
          : behavior.type === 'echo-error'
            ? [errorFrame(400, `invalid key ${bearer}`)]
            : responsesFrames(
                `${ws.data.server === 'mock' ? 'MOCK' : 'OTHER-ORIGIN'}-WS-REPLY-${++replies}`,
                String(replies),
              )
      for (const frame of out) ws.send(frame)
    },
  }
  const upgrade = (
    server: WireRecord['server'],
    request: Request,
    host: Bun.Server<SocketData>,
    entry: Omit<WireRecord, 'behavior'>,
  ) => {
    const socket = ++socketCount
    records.push({ ...entry, behavior: 'accept', socket })
    const ok = host.upgrade(request, {
      data: {
        server,
        socket,
        path: entry.path,
        authorization: entry.authorization,
        headers: [...entry.headers],
      },
    })
    return ok ? undefined : new Response('upgrade failed', { status: 400 })
  }
  const other = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const entry = await record('other', request)
      if (entry.kind === 'handshake')
        return upgrade('other', request, server, entry)
      records.push(entry)
      if (isResponses(entry.path))
        return sse(responsesFrames(`OTHER-ORIGIN-REPLY-${++replies}`, 'o'))
      return completion(`OTHER-ORIGIN-REPLY-${++replies}`)
    },
    websocket,
  })
  const mock = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const entry = await record('mock', request)
      const bearer = bearerOf(request.headers)
      if (entry.kind === 'handshake') {
        const behavior = handshakes.shift() ?? { type: 'accept' }
        if (behavior.type === 'accept')
          return upgrade('mock', request, server, entry)
        records.push({ ...entry, behavior: `${behavior.type}` })
        return behavior.type === 'status'
          ? Response.json(
              { error: { message: 'mock handshake refusal' } },
              { status: behavior.status },
            )
          : new Response(null, {
              status: behavior.status,
              headers: { location: behavior.location(bearer) },
            })
      }
      const behavior =
        entry.kind === 'primary'
          ? (queue.shift() ?? { type: 'ok' })
          : { type: 'ok' as const }
      records.push({ ...entry, behavior: behavior.type })
      switch (behavior.type) {
        case 'status':
          return new Response(
            behavior.body ?? '{"error":{"message":"mock refusal"}}',
            {
              status: behavior.status,
              headers: {
                'content-type': 'application/json',
                ...behavior.headers,
              },
            },
          )
        case 'echo-error':
          return Response.json(
            {
              error: {
                message: `invalid key ${bearer}`,
                type: 'invalid_request_error',
              },
            },
            { status: 400, headers: { 'x-echo': bearer } },
          )
        case 'echo-sse':
          return new Response(
            `${chunk('partial ', null)}data: ${JSON.stringify({ error: { message: `stream failed for ${bearer}`, code: 'mock_error' } })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          )
        case 'redirect':
          return new Response(null, {
            status: behavior.status,
            headers: { location: behavior.location(bearer) },
          })
        default:
          if (isResponses(entry.path))
            return sse(
              responsesFrames(`MOCK-HTTP-REPLY-${++replies}`, `h${replies}`),
            )
          return completion(`MOCK-REPLY-${++replies}`)
      }
    },
    websocket,
  })
  const resets: string[] = []
  const sockets = new Set<Socket>()
  const reset = createServer((socket) => {
    sockets.add(socket)
    socket.once('data', (data) => {
      resets.push(
        String(data)
          .split('\r\n')[0]
          ?.replace(/leak\/\S+/, 'leak/<bearer>') ?? '',
      )
      socket.destroy()
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => reset.listen(0, '127.0.0.1', resolve))
  const address = reset.address()
  const resetPort = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${mock.port}`,
    otherURL: `http://127.0.0.1:${other.port}`,
    resetURL: `http://127.0.0.1:${resetPort}`,
    resets,
    records,
    next(...behaviors) {
      queue.push(...behaviors)
    },
    nextHandshake(...behaviors) {
      handshakes.push(...behaviors)
    },
    nextFrame(...behaviors) {
      frames.push(...behaviors)
    },
    clear() {
      queue.length = 0
      handshakes.length = 0
      frames.length = 0
    },
    async waitForPrimaries(count, ms = 60_000) {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (records.filter((r) => r.kind === 'primary').length >= count)
          return true
        await Bun.sleep(100)
      }
      return false
    },
    async stop() {
      await mock.stop(true)
      await other.stop(true)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => reset.close(() => resolve()))
    },
  }
}
