// A harness that runs the real Pi CLI in RPC mode with an isolated agent
// folder, a loopback mock provider and a fake vault. Every Pi it starts gets
// its own PI_CODING_AGENT_DIR, HOME and USERPROFILE under target/scratch, so a
// test never reads or writes the real ~/.pi.
import { afterEach } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { buildPiBundle } from '../build.ts'
import type { PiTestConfig } from '../test-entry.ts'

export const e2e = process.env.CLAUSTRUM_AUTH_PI_E2E === '1'
const root = path.join(import.meta.dir, '..', '..', '..')
// The pinned Pi CLI, wherever the package manager placed it.
const piCli = path.join(
  path.dirname(
    Bun.resolveSync('@earendil-works/pi-coding-agent', import.meta.dir),
  ),
  'bundle',
  'cli.js',
)

const cleanup: (() => Promise<unknown> | unknown)[] = []
// Stopping Pi and removing its folders can take several seconds on Windows.
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
}, 60_000)

export async function scratch(prefix: string) {
  // On Windows, common-auth refuses to write owner-only files below a junction
  // or symlink. If the checkout sits under one, set CLAUSTRUM_AUTH_PI_SCRATCH
  // to a folder that does not.
  const base =
    process.env.CLAUSTRUM_AUTH_PI_SCRATCH ??
    path.join(root, 'target', 'scratch')
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(path.join(base, `${prefix}-`))
  cleanup.push(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  )
  return dir
}

let bundles: Promise<{ test: string; production: string }> | undefined
// Pi loads the same kind of artifact it loads in production: one bundled ESM
// file whose host modules and vault clients stay external. The test build
// differs only in its entry, which adds the fixture providers.
export function piBundles() {
  bundles ??= (async () => {
    const out = path.join(import.meta.dir, '..', 'target', 'e2e')
    const [test] = await buildPiBundle(
      path.join(import.meta.dir, '..', 'test-entry.ts'),
      path.join(out, 'test'),
    )
    const [production] = await buildPiBundle(
      path.join(import.meta.dir, '..', 'src', 'index.ts'),
      path.join(out, 'production'),
    )
    if (!test || !production) throw new Error('Pi bundle missing')
    return { test, production }
  })()
  return bundles
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve(undefined))
      }),
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export interface SeenRequest {
  origin: string
  path: string
  method: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
export function completionStream(text: string) {
  const base = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
  }
  return (
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: null,
        },
      ],
    }) +
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) +
    'data: [DONE]\n\n'
  )
}

export function responsesStream(text: string) {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const event = (type: string, value: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
  return (
    event('response.created', {
      response: { id: 'resp_1', status: 'in_progress', output: [] },
    }) +
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    }) +
    event('response.content_part.added', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }) +
    event('response.output_text.delta', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text,
    }) +
    event('response.output_item.done', { output_index: 0, item }) +
    event('response.completed', {
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })
  )
}

type Handler = (
  request: SeenRequest,
  response: ServerResponse,
  raw: IncomingMessage,
) => void

/**
 * A loopback provider. The first path segment of each model's base URL picks
 * the scenario, so one Pi process can exercise several behaviours.
 */
export async function mockProvider() {
  const seen: SeenRequest[] = []
  const second: SeenRequest[] = []
  const counters = new Map<string, number>()
  const count = (key: string) => {
    const value = (counters.get(key) ?? 0) + 1
    counters.set(key, value)
    return value
  }
  const sse = (response: ServerResponse, body: string) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(body)
  }
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  let secondOrigin = ''
  const ok = (request: SeenRequest, response: ServerResponse) =>
    request.path.endsWith('/responses')
      ? sse(response, responsesStream('served-ok'))
      : sse(response, completionStream('served-ok'))
  const scenarios: Record<string, Handler> = {
    ok,
    first429(request, response) {
      if (String(request.headers.authorization).includes('secret-a1-'))
        json(response, 429, { error: { message: 'first account limited' } })
      else ok(request, response)
    },
    all429(_request, response) {
      json(response, 429, {
        error: { message: `provider limit ${count('all429')}` },
      })
    },
    all401(_request, response) {
      json(response, 401, {
        error: { message: `provider rejected key ${count('all401')}` },
      })
    },
    echo(request, response) {
      json(response, 400, {
        error: { message: `bad key ${request.headers.authorization}` },
      })
    },
    echosse(request, response) {
      sse(
        response,
        chunk({
          error: { message: `bad key ${request.headers.authorization}` },
        }),
      )
    },
    reset(_request, _response, raw) {
      raw.socket.destroy()
    },
    redirect(request, response) {
      const status = Number(request.path.split('/')[2])
      response.writeHead(status, {
        location: `${secondOrigin}/landing/v1/chat/completions?${encodeURIComponent(String(request.headers.authorization))}`,
      })
      response.end()
    },
    same(request, response) {
      const status = Number(request.path.split('/')[2])
      response.writeHead(status, { location: '/ok/v1/chat/completions' })
      response.end()
    },
    client: ok,
  }
  const server = createServer(async (raw, response) => {
    const request: SeenRequest = {
      origin: '',
      path: raw.url ?? '',
      method: raw.method ?? '',
      headers: raw.headers,
      body: await readBody(raw),
    }
    request.origin = origin
    seen.push(request)
    const scenario = request.path.split('/')[1] ?? ''
    const handler = scenarios[scenario]
    if (handler) handler(request, response, raw)
    else json(response, 404, { error: { message: 'unknown scenario' } })
  })
  const origin = await listen(server)
  const secondServer = createServer(async (raw, response) => {
    second.push({
      origin: secondOrigin,
      path: raw.url ?? '',
      method: raw.method ?? '',
      headers: raw.headers,
      body: await readBody(raw),
    })
    sse(response, completionStream('second-origin'))
  })
  secondOrigin = await listen(secondServer)
  return { origin, secondOrigin, seen, second }
}

export function row(
  id: string,
  provider: string,
  overrides: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return {
    id,
    accountId: `account-${id}`,
    categories: ['llm-provider'],
    credentialType: 'api_key',
    authMethod: 'apikey',
    providerIds: [provider],
    serves: [],
    operations: ['read'],
    state: 'active',
    recordVersion: 1,
    createdAtMs: null,
    ...overrides,
  }
}

export const secretOf = (id: string, version = 1) => `secret-${id}-${version}-x`

/** The fake vault the test build reaches over HTTP; it counts every call. */
export async function fakeVault(initial: ScopedInventoryRow[] = []) {
  const state = {
    rows: initial,
    down: false,
    /** Fail reads only; listing keeps working. */
    readsDown: false,
    version: 1,
    lists: 0,
    reads: [] as string[],
    reports: [] as { credentialId: string; recordVersion: number }[],
    /** Per credential: the account the read asserts, or null for none. */
    servedAccounts: new Map<string, string | null>(),
  }
  const server = createServer(async (raw, response) => {
    const op = (raw.url ?? '').slice(1)
    const input = JSON.parse((await readBody(raw)) || '{}')
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (state.down) return reply(503, {})
    if (op === 'list') {
      state.lists++
      return reply(200, {
        rows: state.rows,
        view: `view-${state.rows.map((r) => r.id).join(',')}-${state.version}`,
      })
    }
    if (op === 'get') {
      if (state.readsDown) return reply(503, {})
      state.reads.push(input.credentialId)
      const listed = state.rows.find((r) => r.id === input.credentialId)
      if (!listed) return reply(404, { code: 'not_found' })
      const served = state.servedAccounts.get(input.credentialId)
      return reply(200, {
        credentialId: input.credentialId,
        material: secretOf(input.credentialId, state.version),
        accountId:
          served === undefined ? listed.accountId : (served ?? undefined),
        recordVersion: state.version,
        expiresAtMs: null,
      })
    }
    if (op === 'report') {
      state.reports.push({
        credentialId: input.credentialId,
        recordVersion: input.recordVersion,
      })
      return reply(200, {})
    }
    reply(404, { code: 'not_found' })
  })
  const url = await listen(server)
  return Object.assign(state, { url })
}

export interface AgentOptions {
  models?: Record<string, unknown>
  auth?: Record<string, unknown>
  /** Write an approved enrollment so the extension starts in vault mode. */
  enrolled?: boolean
  flags?: Record<string, { consented?: boolean; released?: boolean }>
}

export async function agentDir(options: AgentOptions = {}) {
  const home = await scratch('pi')
  const agent = path.join(home, 'agent')
  await mkdir(agent, { recursive: true })
  await writeFile(
    path.join(agent, 'models.json'),
    JSON.stringify({ providers: options.models ?? {} }, null, 2),
  )
  if (options.auth)
    await writeFile(
      path.join(agent, 'auth.json'),
      JSON.stringify(options.auth, null, 2),
    )
  // Setup creates the plugin's folder owner-only before it enrolls.
  const state = path.join(agent, 'claustrum-auth')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  if (options.enrolled ?? true) await enroll(agent)
  if (options.flags)
    await writeJsonAtomic(path.join(state, 'pi-activation.json'), {
      version: 1,
      providers: options.flags,
    })
  return { home, agent, state, authPath: path.join(agent, 'auth.json') }
}

export async function enroll(agent: string) {
  await writeJsonAtomic(
    path.join(agent, 'claustrum-auth', 'pi-enrollment.json'),
    { token: '01'.repeat(32), token_generation: 1 },
  )
}

export async function unenroll(agent: string) {
  await rm(path.join(agent, 'claustrum-auth', 'pi-enrollment.json'), {
    force: true,
  })
}

/** A models.json provider whose models each pick a mock scenario. */
export function provider(
  origin: string,
  models: {
    id: string
    scenario?: string
    api?: string
    baseUrl?: string
    headers?: Record<string, string>
  }[],
  api = 'openai-completions',
) {
  return {
    baseUrl: `${origin}/ok/v1`,
    api,
    models: models.map((model) => ({
      id: model.id,
      ...(model.api ? { api: model.api } : {}),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.baseUrl || model.scenario
        ? { baseUrl: model.baseUrl ?? `${origin}/${model.scenario}/v1` }
        : {}),
    })),
  }
}

export interface RpcRecord {
  type: string
  id?: string
  [key: string]: unknown
}

export interface PiOptions {
  agent: { home: string; agent: string }
  config?: Partial<PiTestConfig>
  mock: { origin: string }
  vault: { url: string }
  /** Load the published bundle instead of the test build. */
  production?: boolean
  /** Load this extension file instead of either bundle. */
  extension?: string
  /** Answer consent dialogs with this; undefined leaves them unanswered. */
  confirm?: boolean
  env?: Record<string, string>
}

export class PiRpc {
  readonly records: RpcRecord[] = []
  readonly notices: string[] = []
  readonly confirms: { title: string; message: string }[] = []
  stderr = ''
  #child: ChildProcess
  #buffer = ''
  #next = 0
  confirm: boolean | undefined
  exited: Promise<number | null>

  constructor(child: ChildProcess, confirm: boolean | undefined) {
    this.#child = child
    this.confirm = confirm
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => this.#read(data))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (data: string) => {
      this.stderr += data
    })
    this.exited = new Promise((resolve) => child.on('exit', resolve))
  }

  #read(data: string) {
    this.#buffer += data
    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index < 0) return
      const line = this.#buffer.slice(0, index).replace(/\r$/u, '')
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line.trim()) continue
      const record = JSON.parse(line) as RpcRecord
      this.records.push(record)
      if (record.type !== 'extension_ui_request') continue
      if (record.method === 'notify') this.notices.push(String(record.message))
      if (record.method === 'confirm') {
        this.confirms.push({
          title: String(record.title),
          message: String(record.message),
        })
        if (this.confirm !== undefined)
          this.#write({
            type: 'extension_ui_response',
            id: record.id,
            confirmed: this.confirm,
          })
      }
    }
  }

  #write(value: unknown) {
    this.#child.stdin?.write(`${JSON.stringify(value)}\n`)
  }

  async waitFor(
    predicate: (record: RpcRecord) => boolean,
    from = 0,
    timeoutMs = 30_000,
  ) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.records.slice(from).find(predicate)
      if (found) return found
      if (this.#child.exitCode !== null || this.#child.signalCode !== null)
        throw new Error(
          `Pi exited (${this.#child.exitCode ?? this.#child.signalCode}): ${this.stderr}\n${JSON.stringify(this.records.slice(-3))}`,
        )
      await Bun.sleep(10)
    }
    throw new Error(
      `Timed out; last records: ${JSON.stringify(this.records.slice(-4))}\n${this.stderr}`,
    )
  }

  async command(command: Record<string, unknown>) {
    const id = `c${this.#next++}`
    this.#write({ ...command, id })
    const response = await this.waitFor(
      (record) => record.type === 'response' && record.id === id,
    )
    if (response.success === false)
      throw new Error(`${command.type} failed: ${response.error}`)
    return response.data as Record<string, unknown> | undefined
  }

  /** Run a slash command and wait for the notice it ends with. */
  async slash(text: string) {
    const before = this.notices.length
    const data = await this.command({ type: 'prompt', message: text })
    if (data?.disposition !== 'handled')
      throw new Error(`${text} was not handled: ${JSON.stringify(data)}`)
    const deadline = Date.now() + 30_000
    while (this.notices.length === before && Date.now() < deadline)
      await Bun.sleep(10)
    return this.notices.slice(before).join('\n')
  }

  /** Select a model, send one prompt and return the assistant's last message. */
  async turn(providerId: string, modelId: string, message = 'hello') {
    await this.command({ type: 'set_model', provider: providerId, modelId })
    const from = this.records.length
    await this.command({ type: 'prompt', message })
    await this.waitFor((record) => record.type === 'agent_settled', from)
    const ends = this.records
      .slice(from)
      .filter(
        (record) =>
          record.type === 'message_end' &&
          (record.message as { role?: string }).role === 'assistant',
      )
    const last = ends.at(-1)?.message as
      | {
          content: { type: string; text?: string }[]
          stopReason?: string
          errorMessage?: string
        }
      | undefined
    if (!last) throw new Error('no assistant message')
    return {
      text: last.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
      stopReason: last.stopReason,
      error: last.errorMessage ?? '',
    }
  }

  async models() {
    const data = await this.command({ type: 'get_available_models' })
    const models = (data?.models ?? []) as { provider: string; id: string }[]
    return models.map((model) => `${model.provider}/${model.id}`)
  }

  /** Everything Pi printed, to search for leaked secrets. */
  output() {
    return `${JSON.stringify(this.records)}\n${this.stderr}`
  }

  async stop() {
    if (this.#child.exitCode !== null) return
    this.#child.stdin?.end()
    const timer = setTimeout(() => this.#child.kill(), 10_000)
    await this.exited
    clearTimeout(timer)
  }

  kill() {
    this.#child.kill('SIGKILL')
    return this.exited
  }
}

export async function startPi(options: PiOptions) {
  const bundle = await piBundles()
  const config: PiTestConfig = {
    origin: options.mock.origin,
    vault: options.vault.url,
    syncMs: 100,
    ...options.config,
  }
  const home = options.agent.home
  // Pi ships for Node; CLAUSTRUM_AUTH_PI_RUNTIME can name another runtime
  // for machines without one.
  const child = spawn(
    process.env.CLAUSTRUM_AUTH_PI_RUNTIME ?? 'node',
    [
      piCli,
      '--mode',
      'rpc',
      '--no-session',
      '--offline',
      '-ne',
      '-e',
      options.extension ??
        (options.production ? bundle.production : bundle.test),
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        PI_CODING_AGENT_DIR: options.agent.agent,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        CLAUSTRUM_AUTH_PI_TEST: JSON.stringify(config),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const pi = new PiRpc(child, options.confirm)
  cleanup.push(() => pi.stop())
  // Wait for startup, and keep Pi's own retries from hiding what the plugin did.
  await pi.command({ type: 'set_auto_retry', enabled: false })
  return pi
}

/** Wait until a condition on files or counters holds. */
export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(25)
  }
  throw new Error('condition not reached')
}

export async function readAuth(authPath: string) {
  return JSON.parse(await readFile(authPath, 'utf8')) as Record<
    string,
    { type: string; key?: string }
  >
}

/** Every file under a folder, for checking that no secret was written. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file) : [file]
  })
}

export function anyFileContains(dir: string, needle: string) {
  return filesUnder(dir).filter((file) =>
    readFileSync(file, 'utf8').includes(needle),
  )
}

export const placeholderOf = (providerId: string) =>
  `cortexkit-claustrum-auth-v1-${providerId}`
