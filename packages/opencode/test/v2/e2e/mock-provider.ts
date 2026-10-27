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
  readonly kind: 'primary' | 'title' | 'other'
  readonly authorization: string | null
  readonly headers: readonly [string, string][]
  readonly behavior?: string
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
  /** Drops every queued behavior. */
  clear(): void
  /** Resolves once `count` agent-loop requests have arrived. */
  waitForPrimaries(count: number, ms?: number): Promise<boolean>
  stop(): Promise<void>
}

export async function startMockProvider(): Promise<MockProvider> {
  const records: WireRecord[] = []
  const queue: Behavior[] = []
  let replies = 0
  const record = async (server: WireRecord['server'], request: Request) => {
    const body = request.method === 'GET' ? '' : await request.text()
    const path = new URL(request.url).pathname
    const kind: WireRecord['kind'] = !path.endsWith('chat/completions')
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
  const other = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      records.push(await record('other', request))
      return completion(`OTHER-ORIGIN-REPLY-${++replies}`)
    },
  })
  const mock = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const entry = await record('mock', request)
      const behavior =
        entry.kind === 'primary'
          ? (queue.shift() ?? { type: 'ok' })
          : { type: 'ok' as const }
      records.push({ ...entry, behavior: behavior.type })
      const bearer = bearerOf(request.headers)
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
          return completion(`MOCK-REPLY-${++replies}`)
      }
    },
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
    clear() {
      queue.length = 0
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
