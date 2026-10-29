// A harness that runs the real Pi CLI in RPC mode with an isolated agent
// folder, a loopback mock provider and a fake vault. Every Pi it starts gets
// its own PI_CODING_AGENT_DIR, HOME and USERPROFILE under target/scratch
// (the user's own temp folder on Windows, where owner-only writes are
// allowed), so a test never reads or writes the real ~/.pi.
import { onTestFinished } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { windowsProcesses } from '../../opencode/test/v2/e2e/windows-processes.ts'
import { buildPiBundle } from '../build.ts'
import type { PiTestConfig } from '../test-entry.ts'
import { PiRpc, runningPi as running } from './rpc.ts'

export { PiRpc, type RpcRecord } from './rpc.ts'

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
let armed = false

/**
 * Runs `close` when the current test finishes, pass or fail.
 *
 * `bun test` loads this module once for all the test files of a run, so an
 * `afterEach` at the top of this file would be attached only to the first
 * file that imported it, and every later file would leave its Pi processes,
 * servers and folders behind. On Windows those leftover Pi processes, each
 * still polling its fake vault, slowed every later Pi start until it missed
 * the 30 s wait. `onTestFinished` attaches to whichever test is running, in
 * any file.
 */
function afterThisTest(close: () => Promise<unknown> | unknown) {
  if (!armed) {
    // Stopping Pi and removing its folders can take several seconds on
    // Windows.
    onTestFinished(async () => {
      armed = false
      for (const close of cleanup.splice(0).reverse()) await close()
      const left = [...running].map((pi) => pi.pid)
      if (left.length)
        throw new Error(
          `Pi still running after the test (pid ${left.join(', ')})`,
        )
    }, 60_000)
    armed = true
    // A Pi still running when a test starts outlived the test that started
    // it: stop it with this test's cleanup, and fail this test.
    const leaked = [...running]
    if (leaked.length) {
      cleanup.push(...leaked.map((pi) => () => pi.stop()), close)
      throw new Error(
        `Pi from an earlier test is still running (pid ${leaked.map((pi) => pi.pid).join(', ')})`,
      )
    }
  }
  cleanup.push(close)
}

/** How long a Windows scratch removal keeps retrying a sharing violation. */
const SCRATCH_REMOVE_BUDGET_MS = 10_000
/** Pause between scratch removal retries on Windows. */
const SCRATCH_REMOVE_INTERVAL_MS = 250

export interface ScratchRemoveRetry {
  /** Defaults to removing `dir` with `rm -rf`. */
  readonly remove?: (dir: string) => Promise<void>
  /** Defaults to `Bun.sleep`. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Defaults to `Date.now`. */
  readonly now?: () => number
  /** Defaults to `process.platform`. */
  readonly platform?: string
  /** Defaults to 10 s. */
  readonly budgetMs?: number
  /** Defaults to 250 ms. */
  readonly intervalMs?: number
  /** Called before every retry. */
  readonly onRetry?: (retry: {
    code: string
    attempt: number
    elapsedMs: number
  }) => void
}

/**
 * Removes a scratch folder. On Windows a sharing violation (EBUSY or EPERM)
 * is retried for a bounded time: virus scanners and the private-files native
 * addon open files without delete sharing, so removing a folder whose files
 * were just written or read can fail even though this process holds nothing
 * open — and the `rm` retry options alone do not cover it under Bun. Every
 * retry is reported, so a real leak holding the folder open still shows as an
 * unbroken run of retries before the final throw. Other platforms remove
 * once: deleting an open file succeeds there, so a failure is never a
 * transient hold.
 */
export async function removeScratchDir(
  dir: string,
  retry: ScratchRemoveRetry = {},
): Promise<void> {
  const platform = retry.platform ?? process.platform
  const budgetMs = retry.budgetMs ?? SCRATCH_REMOVE_BUDGET_MS
  const intervalMs = retry.intervalMs ?? SCRATCH_REMOVE_INTERVAL_MS
  const remove =
    retry.remove ??
    ((target: string) =>
      rm(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      }))
  const sleep = retry.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = retry.now ?? (() => Date.now())
  const started = now()
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(dir)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown'
      if (
        platform !== 'win32' ||
        (code !== 'EBUSY' && code !== 'EPERM') ||
        now() - started >= budgetMs
      )
        throw error
      retry.onRetry?.({ code, attempt, elapsedMs: now() - started })
      await sleep(intervalMs)
    }
  }
}

export async function scratch(prefix: string) {
  // On Windows, common-auth refuses to write owner-only files below a folder
  // other users may change (a CI checkout under D:\a\ is one) or below a
  // junction or symlink, so the scratch goes in the user's own temp folder.
  // CLAUSTRUM_AUTH_PI_SCRATCH overrides both.
  const base =
    process.env.CLAUSTRUM_AUTH_PI_SCRATCH ??
    (process.platform === 'win32'
      ? path.join(os.tmpdir(), 'claustrum-auth-scratch')
      : path.join(root, 'target', 'scratch'))
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(path.join(base, `${prefix}-`))
  afterThisTest(() =>
    removeScratchDir(dir, {
      onRetry: ({ code, attempt, elapsedMs }) =>
        console.warn(
          `claustrum-auth pi scratch removal hit ${code}, retrying (attempt ${attempt} after ${elapsedMs}ms): ${dir}`,
        ),
    }),
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
  afterThisTest(
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
    /** Hold each list this long before answering, as a slow vault does. */
    listDelayMs: 0,
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
      if (state.listDelayMs > 0) await Bun.sleep(state.listDelayMs)
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
        // Custody refuses an OAuth read with no expiry, so an OAuth row is
        // served with an hour left, as the vault serves a minted token.
        expiresAtMs:
          listed.credentialType === 'oauth' ? Date.now() + 3_600_000 : null,
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
  // Setup creates the plugin's folder owner-only before it enrolls, so an
  // enrolled profile starts with it. A profile that is not enrolled yet has no
  // such folder, and setup creates it. Pre-creating it here would not match
  // setup on Windows: Node ignores the mode there, the folder keeps the
  // permissions it inherits, and the enrollment token may not be written into
  // a folder that is not owner-only.
  const state = path.join(agent, 'claustrum-auth')
  if (options.enrolled ?? true) {
    mkdirSync(state, { recursive: true, mode: 0o700 })
    await enroll(agent)
  }
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

export interface PiOptions {
  agent: { home: string; agent: string }
  config?: Partial<PiTestConfig>
  mock: { origin: string }
  vault: { url: string }
  /** Load the published bundle instead of the test build. */
  production?: boolean
  /** Load this extension file instead of either bundle. */
  extension?: string
  /** More extension files Pi loads beside the plugin, in this order. */
  extensions?: string[]
  /** Answer consent dialogs with this; undefined leaves them unanswered. */
  confirm?: boolean
  env?: Record<string, string>
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
      ...(options.extensions ?? []).flatMap((file) => ['-e', file]),
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
  afterThisTest(() => pi.stop())
  // Wait for startup, and keep Pi's own retries from hiding what the plugin did.
  await pi.command({ type: 'set_auto_retry', enabled: false })
  return pi
}

export interface ProcessRow {
  pid: number
  parent: number
  name: string
  /** Windows only: when the process started, to tell a reused PID apart. */
  created?: number
}

/** Every process on the machine, from one snapshot. */
async function processes(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return windowsProcesses()
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (listed.status !== 0)
    throw new Error(`ps failed: ${listed.error ?? listed.stderr}`)
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match) => match !== null)
    .map(([, pid, parent, name]) => ({
      pid: Number(pid),
      parent: Number(parent),
      name: name ?? '',
    }))
}

/** A running process and every process below it. */
export async function processTree(root: number) {
  const rows = await processes()
  const tree = rows.filter((row) => row.pid === root)
  for (let added = true; added; ) {
    added = false
    for (const row of rows)
      if (
        !tree.includes(row) &&
        tree.some((member) => member.pid === row.parent)
      ) {
        tree.push(row)
        added = true
      }
  }
  return tree
}

/**
 * The processes of an earlier `processTree` that are still running. The
 * parent is not compared: a child whose parent exited is moved to another
 * parent on Linux and macOS.
 */
export async function stillRunning(tree: ProcessRow[]) {
  const rows = await processes()
  return tree.filter((member) =>
    rows.some(
      (row) =>
        row.pid === member.pid &&
        row.name === member.name &&
        row.created === member.created,
    ),
  )
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

/**
 * Every file under a folder, for checking that no secret was written. A
 * file that vanishes between the listing and the read holds nothing to
 * scan, so it is skipped instead of failing the check.
 */
export function filesUnder(dir: string): string[] {
  let entries: Dirent[]
  try {
    if (!existsSync(dir)) return []
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file) : [file]
  })
}

/**
 * Reads one scanned file, retrying a Windows sharing violation while Pi
 * still holds the file, and skipping files that vanished meanwhile. Only
 * the scan uses this: the leak check must never fail on a file that is
 * already gone.
 */
function readScanned(file: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return ''
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EBUSY') &&
        attempt < 20
      ) {
        Bun.sleepSync(100)
        continue
      }
      throw error
    }
  }
}

export function anyFileContains(dir: string, needle: string) {
  return filesUnder(dir).filter((file) => readScanned(file).includes(needle))
}

export const placeholderOf = (providerId: string) =>
  `cortexkit-claustrum-auth-v1-${providerId}`
