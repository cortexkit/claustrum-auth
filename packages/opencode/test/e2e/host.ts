// Real-host tests on pinned OpenCode 1 (design sections 14.2 and 14.3), with
// the fixture providers and a loopback mock. Gated: set
// CLAUSTRUM_AUTH_OPENCODE1_E2E=1. The host is installed from npm into
// target/opencode1-host unless CLAUSTRUM_AUTH_OPENCODE1_DIR names an existing
// install. Runs on Linux, macOS and Windows.
import { expect } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostEnrollmentPaths } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import type { VaultControl } from './fixture-plugin.ts'

export const enabled = process.env.CLAUSTRUM_AUTH_OPENCODE1_E2E === '1'
export const hostVersion = '1.19.3'
const repo = path.join(import.meta.dir, '..', '..', '..', '..')
const win = process.platform === 'win32'
// A refused loopback connect is immediate on Linux and macOS but can take
// about two seconds on Windows, which retries the connect.
export const slow = win ? 3 : 1

export function placeholderOf(provider: string) {
  return `cortexkit-claustrum-auth:v1:${provider}`
}

export function vaultRow(
  id: string,
  provider: string,
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
  }
}

// ---------- the pinned host ----------

function binaryIn(root: string): string | undefined {
  const modules = path.join(root, 'node_modules')
  if (!existsSync(modules)) return undefined
  const os = win ? 'windows' : process.platform
  const prefix = `opencode-${os}-${process.arch}`
  const names = readdirSync(modules)
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => a.length - b.length)
  for (const name of names) {
    const file = path.join(
      modules,
      name,
      'bin',
      win ? 'opencode.exe' : 'opencode',
    )
    if (existsSync(file)) return file
  }
  return undefined
}

let installed: string | undefined
export function hostBinary(): string {
  if (installed) return installed
  const root =
    process.env.CLAUSTRUM_AUTH_OPENCODE1_DIR ??
    path.join(repo, 'target', 'opencode1-host')
  let binary = binaryIn(root)
  if (!binary) {
    mkdirSync(root, { recursive: true })
    const manifest = path.join(root, 'package.json')
    if (!existsSync(manifest))
      writeFileSync(
        manifest,
        JSON.stringify({
          private: true,
          dependencies: { 'opencode-ai': hostVersion },
        }),
      )
    const result = spawnSync(
      win ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8', shell: win, timeout: 600_000 },
    )
    if (result.status !== 0)
      throw new Error(`npm install failed: ${result.stderr}`)
    binary = binaryIn(root)
  }
  if (!binary)
    throw new Error(`no OpenCode ${hostVersion} binary under ${root}`)
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  expect(version.stdout.trim()).toBe(hostVersion)
  installed = binary
  return binary
}

// ---------- the loopback mock provider ----------

export interface Recorded {
  origin: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
  title: boolean
}
export type Reply =
  | { kind: 'ok'; text?: string }
  | {
      kind: 'status'
      status: number
      body: string
      headers?: Record<string, string>
    }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'sse-error'; message: string }
  | { kind: 'reset' }

export interface Mock {
  origin: string
  requests: Recorded[]
  reply: (request: Recorded) => Reply
  close(): Promise<void>
}

function chunk(delta: object, finish: string | null = null) {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function sendOk(res: ServerResponse, stream: boolean, text: string) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    `data: ${JSON.stringify(chunk({ role: 'assistant', content: text }))}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({
      ...chunk({}, 'stop'),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  )
  res.end('data: [DONE]\n\n')
}

export async function startMock(): Promise<Mock> {
  const mock: Mock = {
    origin: '',
    requests: [],
    reply: () => ({ kind: 'ok' }),
    close: async () => {},
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8')
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers))
        headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
      const recorded: Recorded = {
        origin: mock.origin,
        method: req.method ?? '',
        path: req.url ?? '',
        headers,
        body,
        // OpenCode names its own title request in the system prompt.
        title: /title generator|generate a title|thread title/iu.test(body),
      }
      mock.requests.push(recorded)
      let stream = false
      try {
        stream = JSON.parse(body).stream === true
      } catch {}
      if (recorded.title) return sendOk(res, stream, 'E2E title')
      const reply = mock.reply(recorded)
      switch (reply.kind) {
        case 'ok':
          return sendOk(res, stream, reply.text ?? 'hello from the mock')
        case 'status':
          res.writeHead(reply.status, {
            'content-type': 'application/json',
            ...reply.headers,
          })
          return res.end(reply.body)
        case 'redirect':
          res.writeHead(reply.status, { location: reply.location })
          return res.end()
        case 'sse-error':
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(
            `data: ${JSON.stringify({ error: { message: reply.message, type: 'server_error' } })}\n\n`,
          )
          return res.end()
        case 'reset':
          req.socket.destroy()
          return
      }
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as AddressInfo
  mock.origin = `http://127.0.0.1:${port}`
  mock.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  return mock
}

// ---------- an isolated profile and one host process ----------

export interface Profile {
  root: string
  project: string
  control: string
  dataDir: string
  configFile: string
  authFile: string
  env: Record<string, string>
  vault(update?: Partial<VaultControl>): Promise<VaultControl>
  vaultLog(): Promise<Record<string, unknown>[]>
  config(provider: Record<string, unknown>): Promise<void>
  auth(): Promise<Record<string, unknown>>
  setAuth(value: Record<string, unknown>): Promise<void>
}

export async function profile(
  name: string,
  mock: Mock,
  control: Partial<VaultControl>,
): Promise<Profile> {
  const scratch = path.join(repo, 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(path.join(scratch, `oc1-${name}-`))
  const dirs = {
    home: path.join(root, 'home'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    state: path.join(root, 'xdg-state'),
    cache: path.join(root, 'cache'),
    tmp: path.join(root, 'tmp'),
    project: path.join(root, 'project'),
    control: path.join(root, 'control'),
    appdata: path.join(root, 'appdata'),
    localappdata: path.join(root, 'localappdata'),
  }
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
  const controlFile = path.join(dirs.control, 'vault.json')
  let current: VaultControl = {
    active: true,
    outage: false,
    rows: [],
    served: {},
    ...control,
  }
  await writeFile(controlFile, JSON.stringify(current))
  await writeJsonAtomic(
    hostEnrollmentPaths({
      stateDir: path.join(dirs.control, 'state'),
      host: 'opencode',
    }).tokenPath,
    { token: '01'.repeat(32), token_generation: 1 },
  )
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Nothing from the developer's own OpenCode or provider keys leaks in.
    if (/^(OPENCODE_|XDG_)|_API_KEY$|^(SUBC_|CLAUSTRUM_)/iu.test(key)) continue
    if (/^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY)$/iu.test(key)) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.localappdata,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    // Anything not on loopback goes to a dead proxy.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    CLAUSTRUM_AUTH_E2E_DIR: dirs.control,
    CLAUSTRUM_AUTH_E2E_ORIGIN: mock.origin,
  })
  const configFile = path.join(dirs.config, 'opencode', 'opencode.json')
  const authFile = path.join(dirs.data, 'opencode', 'auth.json')
  await mkdir(path.dirname(configFile), { recursive: true })
  await seedPluginSdk(path.dirname(configFile))
  await mkdir(path.dirname(authFile), { recursive: true })
  const result: Profile = {
    root,
    project: dirs.project,
    control: dirs.control,
    dataDir: dirs.data,
    configFile,
    authFile,
    env,
    async vault(update) {
      if (update) {
        current = { ...current, ...update }
        await writeFile(controlFile, JSON.stringify(current))
      }
      return current
    },
    async vaultLog() {
      const file = path.join(dirs.control, 'vault-log.jsonl')
      if (!existsSync(file)) return []
      return (await readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    async config(provider) {
      await writeFile(
        configFile,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          autoupdate: false,
          share: 'disabled',
          plugin: [
            pathToFileURL(path.join(import.meta.dir, 'fixture-plugin.ts')).href,
          ],
          provider,
        }),
      )
    },
    async auth() {
      if (!existsSync(authFile)) return {}
      return JSON.parse(await readFile(authFile, 'utf8'))
    },
    async setAuth(value) {
      await writeFile(authFile, JSON.stringify(value))
    },
  }
  await result.config(fixtureProviders(mock.origin))
  return result
}

// OpenCode 1 installs its plugin SDK into each config directory and waits
// for it before serving. With non-loopback traffic sent to a dead proxy that
// install only fails after its retries, about a minute per start. OpenCode
// skips it when node_modules exists and package-lock.json already lists the
// SDK (Npm.install in its core npm module), so the profile starts that way. The
// fixture plugin is loaded by path and needs nothing from that directory.
async function seedPluginSdk(configDir: string) {
  const dependencies = { '@opencode-ai/plugin': hostVersion }
  await mkdir(path.join(configDir, 'node_modules'), { recursive: true })
  await writeFile(
    path.join(configDir, 'package.json'),
    JSON.stringify({ dependencies }),
  )
  await writeFile(
    path.join(configDir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies } } }),
  )
}

export function fixtureProviders(origin: string, base = origin) {
  const model = { m: { name: 'm', limit: { context: 8000, output: 1000 } } }
  return {
    'fixture-a': {
      name: 'Fixture A',
      npm: '@ai-sdk/openai-compatible',
      env: ['FIXTURE_A_API_KEY'],
      options: { baseURL: `${base}/v1` },
      models: model,
    },
    'fixture-b': {
      name: 'Fixture B',
      npm: '@ai-sdk/openai-compatible',
      env: ['FIXTURE_B_API_KEY'],
      options: { baseURL: `${origin}/client/v4/accounts/listed-account/ai/v1` },
      models: model,
    },
    'fixture-c': {
      name: 'Fixture C',
      npm: '@ai-sdk/anthropic',
      env: ['FIXTURE_C_API_KEY'],
      options: { baseURL: `${origin}/v1` },
      models: model,
    },
  }
}

export interface Host {
  url: string
  output(): string
  stop(): Promise<void>
  api(method: string, route: string, body?: unknown): Promise<Response>
  session(): Promise<string>
  turn(provider: string, text?: string): Promise<TurnResult>
  retrying(provider: string): Promise<{ message: string; session: string }>
  command(sessionID: string, args: string): Promise<string>
  logs(): Promise<string>
}
export interface TurnResult {
  session: string
  error?: string
  text: string
  raw: string
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function startHost(
  profile: Profile,
  extraEnv: Record<string, string> = {},
): Promise<Host> {
  const binary = hostBinary()
  const port = await freePort()
  let output = ''
  const child: ChildProcess = spawn(
    binary,
    [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'DEBUG',
    ],
    {
      cwd: profile.project,
      env: { ...profile.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout?.on('data', (data) => {
    output += String(data)
  })
  child.stderr?.on('data', (data) => {
    output += String(data)
  })
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  )
  const url = `http://127.0.0.1:${port}`
  const api = (method: string, route: string, body?: unknown) => {
    const target = new URL(route, url)
    target.searchParams.set('directory', profile.project)
    return fetch(target, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  }
  // Ask only once the host says it listens, and give each readiness request a
  // short timeout: a request that lands while the host is still wiring its
  // server can hang without an answer.
  const deadline = Date.now() + 180_000
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`OpenCode exited during start:\n${output}`)
    if (output.includes('server listening')) {
      try {
        const target = new URL('/config', url)
        target.searchParams.set('directory', profile.project)
        const response = await fetch(target, {
          signal: AbortSignal.timeout(20_000),
        })
        if (response.ok) break
      } catch {}
    }
    if (Date.now() > deadline)
      throw new Error(`OpenCode did not start:\n${output}`)
    await Bun.sleep(250)
  }
  const host: Host = {
    url,
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill()
      await Promise.race([exited, Bun.sleep(10_000)])
    },
    api,
    async session() {
      const response = await api('POST', '/session', {})
      expect(response.status).toBe(200)
      return ((await response.json()) as { id: string }).id
    },
    async turn(provider, text = 'claustrum-e2e-turn') {
      const session = await host.session()
      const response = await api('POST', `/session/${session}/message`, {
        model: { providerID: provider, modelID: 'm' },
        parts: [{ type: 'text', text }],
      })
      const raw = await response.text()
      let error: string | undefined
      let reply = ''
      try {
        const value = JSON.parse(raw) as {
          info?: { error?: { data?: { message?: string }; name?: string } }
          parts?: { type: string; text?: string }[]
          data?: { message?: string }
          message?: string
        }
        const info = value.info?.error
        error = info
          ? (info.data?.message ?? info.name ?? 'error')
          : response.ok
            ? undefined
            : (value.data?.message ?? value.message ?? raw)
        reply = (value.parts ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('')
      } catch {
        error = raw || `HTTP ${response.status}`
      }
      return { session, error, text: reply, raw }
    },
    async retrying(provider) {
      const session = await host.session()
      const response = await api('POST', `/session/${session}/prompt_async`, {
        model: { providerID: provider, modelID: 'm' },
        parts: [{ type: 'text', text: 'claustrum-e2e-turn' }],
      })
      expect(response.status).toBeLessThan(300)
      const deadline = Date.now() + 60_000 * slow
      try {
        for (;;) {
          const status = (await (
            await api('GET', '/session/status')
          ).json()) as Record<string, { type: string; message?: string }>
          const mine = status[session]
          if (mine?.type === 'retry')
            return { message: mine.message ?? '', session }
          if (Date.now() > deadline)
            throw new Error(`no retry status: ${JSON.stringify(status)}`)
          await Bun.sleep(100)
        }
      } finally {
        await api('POST', `/session/${session}/abort`, {})
      }
    },
    async command(sessionID, args) {
      const before = await messagesText(api, sessionID)
      await api('POST', `/session/${sessionID}/command`, {
        command: 'claustrum',
        arguments: args,
      }).then((response) => response.text())
      const deadline = Date.now() + 30_000
      for (;;) {
        const now = await messagesText(api, sessionID)
        const fresh = now.slice(before.length)
        const shown = fresh.find((text) => text.startsWith('claustrum-auth'))
        if (shown) return shown
        if (Date.now() > deadline)
          throw new Error(`no command output:\n${output.slice(-4000)}`)
        await Bun.sleep(100)
      }
    },
    async logs() {
      const dir = path.join(profile.dataDir, 'opencode', 'log')
      if (!existsSync(dir)) return ''
      return readdirSync(dir)
        .map((name) => readFileSync(path.join(dir, name), 'utf8'))
        .join('\n')
    },
  }
  return host
}

async function messagesText(
  api: Host['api'],
  sessionID: string,
): Promise<string[]> {
  const response = await api('GET', `/session/${sessionID}/message`)
  const messages = (await response.json()) as {
    parts?: { type: string; text?: string }[]
  }[]
  return messages.flatMap((message) =>
    (message.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? ''),
  )
}

// What the host shows for a session: every message and part, as stored.
export async function sessionDump(host: Host, sessionID: string) {
  const response = await host.api('GET', `/session/${sessionID}/message`)
  return await response.text()
}

export function realProfileStamp(): string {
  const file = path.join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  if (!existsSync(file)) return 'absent'
  const stat = statSync(file)
  return `${stat.size}:${stat.mtimeMs}`
}
