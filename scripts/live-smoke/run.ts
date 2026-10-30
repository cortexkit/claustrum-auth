import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort } from '../../packages/opencode/test/v2/e2e/host.ts'
import { PiRpc } from '../../packages/pi/test/rpc.ts'

export const repo = fileURLToPath(new URL('../../', import.meta.url))
export type Host = 'opencode1' | 'opencode2' | 'pi'
const hosts: Host[] = ['opencode1', 'opencode2', 'pi']
const providers = [
  'cerebras',
  'deepseek',
  'fireworks',
  'inception',
  'cline-pass',
  'kimi-coding',
  'openrouter',
  'typesafe',
  'meta',
  'xai',
  'opencode-go',
  'opencode-zen',
]
export function matrix(host: Host) {
  return providers.filter(
    (p) =>
      host !== 'pi' || !['inception', 'cline-pass', 'typesafe'].includes(p),
  )
}
export function providerID(host: Host, p: string) {
  return p === 'opencode-zen'
    ? host === 'opencode2'
      ? p
      : 'opencode'
    : host !== 'pi' && p === 'fireworks'
      ? 'fireworks-ai'
      : host !== 'pi' && p === 'kimi-coding'
        ? 'kimi-code-plan-global'
        : p
}

export class SmokeError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const failure = (error: unknown) =>
  error instanceof SmokeError
    ? error.code
    : error instanceof Error &&
        [
          'Error',
          'TypeError',
          'SyntaxError',
          'RangeError',
          'TimeoutError',
          'AbortError',
        ].includes(error.name)
      ? error.name
      : 'DriverError'

// Treat the connection and executables as read-only inputs. Every mutable host
// path is checked, including existing symlink ancestors, before the first spawn.
function scratchHome(value: string) {
  const home = realpathSync(value)
  // HOME may already select the scratch profile; use the OS account instead.
  const account = userInfo().homedir
  const actual = existsSync(account)
    ? realpathSync(account)
    : path.resolve(account)
  if (home === actual || home === path.parse(home).root)
    throw new SmokeError('LiveHomeMustBeScratch')
  return home
}

export function confined(home: string, candidate: string) {
  const root = realpathSync(home)
  let ancestor = path.resolve(candidate)
  const tail: string[] = []
  while (!existsSync(ancestor)) {
    if (lstatExists(ancestor)) throw new SmokeError('DanglingSymlink')
    tail.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new SmokeError('MissingAncestor')
    ancestor = parent
  }
  const resolved = path.resolve(realpathSync(ancestor), ...tail)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new SmokeError('PathOutsideLiveHome')
  return resolved
}
function lstatExists(file: string) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

export function environment(home: string, connection: string, host?: Host) {
  const dataRoot = host ? path.join(home, '.live-smoke', host) : home
  // Enrollment is bound to the config folder. Both OpenCode versions must use
  // the default folder to find the scratch home's existing enrollment.
  const configRoot = host === 'pi' ? dataRoot : home
  const dirs = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, '.config'),
    LOCALAPPDATA: path.join(home, '.local/share'),
    XDG_RUNTIME_DIR: path.join(home, '.live-smoke/runtime'),
    XDG_CONFIG_DIRS: path.join(configRoot, '.config'),
    XDG_DATA_DIRS: path.join(dataRoot, '.local/share'),
    XDG_CONFIG_HOME: path.join(configRoot, '.config'),
    XDG_DATA_HOME: path.join(dataRoot, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(dataRoot, '.cache'),
    TMPDIR: path.join(home, '.live-smoke/tmp'),
    TMP: path.join(home, '.live-smoke/tmp'),
    TEMP: path.join(home, '.live-smoke/tmp'),
    OPENCODE_CONFIG_DIR: path.join(configRoot, '.config/opencode'),
    OPENCODE_CONFIG: path.join(configRoot, '.config/opencode/opencode.json'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    npm_config_cache: path.join(home, '.cache/npm'),
  }
  for (const dir of Object.values(dirs)) confined(home, dir)
  const password = crypto.randomUUID()
  return {
    PATH: process.env.PATH ?? '',
    ...dirs,
    CLAUSTRUM_SUBC_CONNECTION: path.resolve(connection),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
    NODE_DISABLE_COMPILE_CACHE: '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
}

export type Leak = { file: string; offset: number }
export function leaks(file: string, bytes: Buffer): Leak[] {
  // latin1 preserves byte offsets even for invalid UTF-8 and binary log files.
  const text = bytes.toString('latin1')
  const patterns = [
    /Bearer |\b(?:sk-or-|csk-|sk-|xai-|fw_)[A-Za-z0-9_-]{16,}/gi,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /(?:authorization|proxy-authorization|api[_-]?key|(?:access|refresh)[_-]?token|\b(?:access|refresh|token|key)\b)["'\s:=\\]*(?:(?:Basic|Bearer)\s+)?[A-Za-z0-9+/_=-]{32,}/gi,
  ]
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((m) => m.index),
      ),
    ),
  ].map((offset) => ({ file, offset }))
}
export function safe(text: string) {
  return leaks('preview', Buffer.from(text)).length
    ? '[credential-shaped output withheld]'
    : text.replace(/[\r\n|]/g, ' ')
}
export function preview(text: string) {
  return safe(text).slice(0, 40)
}
function files(home: string, dir = home): string[] {
  confined(home, dir)
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    confined(home, file)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory()
      ? files(home, file)
      : entry.isFile()
        ? [file]
        : []
  })
}
function stamp(home: string) {
  return new Map(
    files(home).map((file) => {
      const s = statSync(file)
      return [file, `${s.size}:${s.mtimeMs}:${s.ctimeMs}`]
    }),
  )
}
function scan(home: string, baseline: Map<string, string>) {
  const found: Leak[] = []
  for (const file of files(home)) {
    const s = statSync(file)
    if (baseline.get(file) === `${s.size}:${s.mtimeMs}:${s.ctimeMs}`) continue
    if (/enrollment\.json$/.test(file))
      throw new SmokeError('EnrollmentModifiedDuringRun')
    found.push(...leaks(path.relative(home, file), readFileSync(file)))
  }
  return found
}

export type Row = {
  passed?: boolean
  provider: string
  status: string
  activation: string
  turn: string
  extras: string
  release: string
  leak: string
}
export function table(host: Host, rows: Row[]) {
  return `# Live smoke: ${host}\n\n| provider | served / refused | activation | turn | extras | release | leak scan |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map((r) => `| ${[r.provider, r.status, r.activation, r.turn, r.extras, r.release, r.leak].map(safe).join(' | ')} |`).join('\n')}\n\nManual: deliberate provider-error probe (step 5), switch back to a personal key (step 6), OpenCode 1 environment-shadow check. No personal keys are used by this driver.\n`
}

export type Model = {
  id: string
  provider?: string
  api?: string
  cost?: { input?: number; output?: number }
  limit?: { output?: number }
  capabilities?: {
    output?: string[] | { text?: boolean }
    toolcall?: boolean
    tools?: boolean
    reasoning?:
      | boolean
      | { supported: boolean; toggle?: boolean; effort?: string[] }
  }
  reasoning?: boolean
  variants?: Record<string, Record<string, unknown>> | { id: string }[]
}

export function smokeVariant(model: Model): string | undefined {
  const variants = Array.isArray(model.variants)
    ? model.variants.map((v) => v.id)
    : Object.keys(model.variants ?? {})
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find(
    (v) => variants.includes(v),
  )
}

function reasoningRank(model: Model) {
  // Some host catalogs expose reasoning controls only as variants. Prefer an
  // explicit off control to guessing that a model without variants is cheap.
  const reasoning = model.capabilities?.reasoning ?? model.reasoning
  if (
    reasoning === false ||
    (typeof reasoning === 'object' && !reasoning.supported)
  )
    return 0
  if (
    smokeVariant(model) === 'none' ||
    (typeof reasoning === 'object' && reasoning.toggle)
  )
    return 0
  const variants = Array.isArray(model.variants)
    ? model.variants.length
    : Object.keys(model.variants ?? {}).length
  return reasoning || variants ? 2 : 1
}

export function smokeTokens(model: Model, host: Host, provider: string) {
  // A 16-token response can consist entirely of hidden reasoning. Meta's
  // captured variants lack an off control; Pi model overrides can also hide
  // Cerebras and Go reasoning metadata.
  // Leave bounded room for an answer without allowing a continuation request.
  const variant = smokeVariant(model)
  return provider === 'meta' ||
    (host === 'pi' && ['cerebras', 'opencode-go'].includes(provider)) ||
    (variant !== undefined && variant !== 'none') ||
    reasoningRank(model) === 2
    ? 1024
    : 16
}

export function cheapest(
  models: Model[],
  host: Host,
  p: string,
  anthropic = false,
) {
  if (!models.length) throw new SmokeError(`NoCatalogModels:${host}:${p}`)
  const candidates = models.filter((m) => {
    // The smoke's OpenCode prompts include tools. Text output alone does not
    // make an edit-only or media model eligible for those chat requests.
    if ((m.capabilities?.toolcall ?? m.capabilities?.tools) === false)
      return false
    const output = m.capabilities?.output
    if (
      output &&
      !(Array.isArray(output) ? output.includes('text') : output.text)
    )
      return false
    const isAnthropic = m.api ? /anthropic/.test(m.api) : /claude/.test(m.id)
    if (
      !anthropic &&
      ['opencode-go', 'opencode-zen', 'fireworks'].includes(p) &&
      m.api
    ) {
      return (
        !isAnthropic && /openai|completions|responses|fireworks/.test(m.api)
      )
    }
    return anthropic
      ? isAnthropic
      : !isAnthropic ||
          !['opencode-go', 'opencode-zen', 'fireworks'].includes(p)
  })
  candidates.sort(
    (a, b) =>
      // Prefer Pi Zen's small Responses model when offered; the captured gpt-5
      // turn was rejected with "Model access is disabled".
      (host === 'pi' && p === 'opencode-zen'
        ? Number(b.id === 'gpt-5.4-mini') - Number(a.id === 'gpt-5.4-mini')
        : 0) ||
      reasoningRank(a) - reasoningRank(b) ||
      (a.cost?.input ?? Infinity) +
        (a.cost?.output ?? Infinity) -
        ((b.cost?.input ?? Infinity) + (b.cost?.output ?? Infinity)) ||
      a.id.localeCompare(b.id),
  )
  if (!candidates.length)
    throw new SmokeError(
      `No${anthropic ? 'Anthropic' : 'Bearer'}Model:${host}:${p}`,
    )
  return candidates[0]
}

export type Options = {
  home: string
  connection: string
  hosts: Host[]
  provider: string
  dry: boolean
}
export function options(args: string[], env = process.env): Options {
  let host = 'all',
    provider = 'all',
    dry = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry') dry = true
    else if (arg === '--host' && args[i + 1]) host = args[++i]
    else if (arg === '--provider' && args[i + 1]) provider = args[++i]
    else
      throw new SmokeError(
        'Usage: --host opencode1|opencode2|pi|all --provider <id>|all [--dry]',
      )
  }
  if (!env.LIVE_HOME || !env.CLAUSTRUM_SUBC_CONNECTION)
    throw new SmokeError('LIVE_HOME and CLAUSTRUM_SUBC_CONNECTION are required')
  if (host !== 'all' && !hosts.includes(host as Host))
    throw new SmokeError('UnknownHost')
  if (provider !== 'all' && !providers.includes(provider))
    throw new SmokeError('UnknownProvider')
  const home = scratchHome(env.LIVE_HOME)
  const selected = (host === 'all' ? hosts : [host as Host]).filter(
    (h) => provider === 'all' || matrix(h).includes(provider),
  )
  if (!selected.length) throw new SmokeError(`ProviderNotListed:${host}`)
  return {
    home,
    connection: path.resolve(env.CLAUSTRUM_SUBC_CONNECTION),
    hosts: selected,
    provider,
    dry,
  }
}

function binary(host: Host) {
  if (host !== 'opencode2') return host === 'pi' ? 'pi' : 'opencode'
  const dir = path.resolve(
    process.env.CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR ??
      path.join(repo, 'target/opencode2-cli'),
  )
  const cli = path.join(dir, 'node_modules/.bin/opencode2')
  if (!existsSync(cli))
    throw new SmokeError(
      'MissingOpenCode2Fixture: set CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR',
    )
  return cli
}
function plan(o: Options) {
  return o.hosts
    .flatMap((host) => {
      const selected = o.provider === 'all' ? matrix(host) : [o.provider]
      const bin =
        host === 'opencode2'
          ? path.resolve(
              process.env.CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR ??
                path.join(repo, 'target/opencode2-cli'),
              'node_modules/.bin/opencode2',
            )
          : host === 'pi'
            ? 'pi'
            : 'opencode'
      const env = environment(o.home, o.connection, host)
      return [
        `${host}: env HOME=${JSON.stringify(o.home)} XDG_CONFIG_HOME=${JSON.stringify(env.XDG_CONFIG_HOME)} XDG_DATA_HOME=${JSON.stringify(env.XDG_DATA_HOME)} XDG_STATE_HOME=${JSON.stringify(env.XDG_STATE_HOME)} XDG_CACHE_HOME=${JSON.stringify(env.XDG_CACHE_HOME)} PI_CODING_AGENT_DIR=${JSON.stringify(env.PI_CODING_AGENT_DIR)}`,
        `${host}: git init -q ${JSON.stringify(path.join(o.home, '.live-smoke', host, 'project'))}`,
        `${host}: npm pack ${path.join(repo, host === 'pi' ? 'packages/pi' : 'packages/opencode')} --json --pack-destination <LIVE_HOME>/.live-smoke/packs --ignore-scripts`,
        ...(host === 'opencode1'
          ? [`${bin} --version (select matching SDK)`]
          : []),
        `${host}: npm install --prefix ${JSON.stringify(host === 'pi' ? env.PI_CODING_AGENT_DIR : env.OPENCODE_CONFIG_DIR)} --ignore-scripts --save-exact --no-audit --no-fund <tarball>${host === 'opencode1' ? ' @opencode-ai/plugin@<host-version>' : ''}`,
        host === 'pi'
          ? 'pi --mode rpc --no-session --offline -ne -e <installed extension>; RPC set_auto_retry false; set_thinking_level off'
          : `${bin} serve --hostname 127.0.0.1 --port <loopback-port> --print-logs`,
        ...selected.flatMap((p) => {
          const id = providerID(host, p)
          return [
            `${host}/${p}: /claustrum status; /claustrum refusals; /claustrum accounts`,
            ...(host === 'opencode2' && p === 'opencode-zen'
              ? ['check not-on-this-host; no activation or turn']
              : [
                  host === 'opencode2'
                    ? `${bin} auth login ${id} --method claustrum-auth --server <loopback-url>`
                    : `/claustrum use ${id}${host === 'pi' ? ' (RPC consent: true)' : ''}`,
                  `${host}/${p}: discover catalog, choose a text/tool model with reasoning off where available, cap output at 16 (1024 for reasoning), restart host, check ownership`,
                  host === 'opencode2'
                    ? `${bin} run --server <loopback-url> --format json --title 'Live smoke' --model ${id}/<cheapest-model> 'Reply with the single word OK.'`
                    : host === 'pi'
                      ? `RPC set_model ${id}/<cheapest-model>; prompt 'Reply with the single word OK.'`
                      : `HTTP POST /session/<session-id>/message model=${id}/<cheapest-model> text='Reply with the single word OK.'`,
                  host === 'opencode2'
                    ? `${bin} auth logout ${id} <activated-credential-id> --server <loopback-url>`
                    : `/claustrum accounts; /claustrum release ${id}`,
                ]),
          ]
        }),
        `${host}: stop host, scan all new/changed data and child stdout/stderr; write ../results-${host}-<timestamp>.md`,
      ]
    })
    .join('\n')
}

class Runner {
  private next = 0
  apiSequence = 0
  httpFallback = false
  readonly vaultIDs = new Map<string, string>()
  readonly children: ChildProcess[] = []
  readonly pending: Promise<unknown>[] = []
  constructor(
    readonly o: Options,
    readonly host: Host,
    readonly env: Record<string, string>,
    readonly binaries: Partial<Record<Host, string>> = {},
  ) {}
  binary() {
    return this.binaries[this.host] ?? binary(this.host)
  }
  get cwd() {
    return path.join(this.o.home, '.live-smoke', this.host, 'project')
  }
  start(argv: string[]) {
    const prefix = path.join(
      this.o.home,
      '.live-smoke',
      this.host,
      `child-${++this.next}`,
    )
    // XDG already selects this directory. Passing OpenCode's additional
    // config overrides as well would load the same plugin more than once.
    const {
      OPENCODE_CONFIG: _config,
      OPENCODE_CONFIG_DIR: _dir,
      ...childEnv
    } = this.env
    const child = spawn(argv[0], argv.slice(1), {
      cwd: this.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.children.push(child)
    const out: Buffer[] = [],
      err: Buffer[] = []
    child.stdout?.on('data', (b: Buffer | string) => {
      out.push(Buffer.from(b))
      this.httpFallback ||= Buffer.concat(out).includes(
        'session websocket connect failed; using http',
      )
      writeFileSync(`${prefix}.stdout`, Buffer.concat(out))
    })
    child.stderr?.on('data', (b: Buffer | string) => {
      err.push(Buffer.from(b))
      this.httpFallback ||= Buffer.concat(err).includes(
        'session websocket connect failed; using http',
      )
      writeFileSync(`${prefix}.stderr`, Buffer.concat(err))
    })
    const done = new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(-1))
      child.once('close', resolve)
    })
    this.pending.push(done)
    return {
      child,
      done,
      text: () => Buffer.concat(out).toString('utf8'),
      error: () => Buffer.concat(err).toString('utf8'),
    }
  }
  async run(argv: string[], ms = 120_000) {
    const task = this.start(argv)
    // OpenCode run reads redirected stdin to EOF before submitting its prompt.
    task.child.stdin?.end()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.kill(task.child)
    }, ms)
    const code = await task.done
    clearTimeout(timer)
    return {
      code: timedOut ? 124 : code,
      text: task.text(),
      error: task.error(),
    }
  }
  kill(child: ChildProcess) {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
  }
  async stop() {
    for (const child of this.children) this.kill(child)
    await Promise.all(this.pending)
  }
}

async function install(r: Runner) {
  const { home } = r.o
  const packDir = path.join(home, '.live-smoke/packs')
  const prefix =
    r.host === 'pi' ? r.env.PI_CODING_AGENT_DIR : r.env.OPENCODE_CONFIG_DIR
  mkdirSync(packDir, { recursive: true })
  mkdirSync(prefix, { recursive: true })
  const source = path.join(
    repo,
    r.host === 'pi' ? 'packages/pi' : 'packages/opencode',
  )
  if (!existsSync(path.join(source, 'dist/index.js')))
    throw new SmokeError('BuildMissing: run bun run build')
  const packed = await r.run([
    'npm',
    'pack',
    source,
    '--json',
    '--pack-destination',
    packDir,
    '--ignore-scripts',
  ])
  if (packed.code !== 0) throw new SmokeError('PackFailed')
  const name = (JSON.parse(packed.text) as { filename: string }[])[0]?.filename
  if (!name || path.basename(name) !== name)
    throw new SmokeError('InvalidPackFilename')
  const sdk: string[] = []
  if (r.host === 'opencode1') {
    const version = (await r.run([r.binary(), '--version'])).text.trim()
    if (!/^1\.\d+\.\d+$/.test(version))
      throw new SmokeError('UnexpectedOpenCode1Version')
    sdk.push(`@opencode-ai/plugin@${version}`)
  }
  const installed = await r.run(
    [
      'npm',
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--save-exact',
      '--no-audit',
      '--no-fund',
      path.join(packDir, name),
      ...sdk,
    ],
    600_000,
  )
  if (installed.code !== 0) throw new SmokeError('InstallFailed')
  return path.join(
    prefix,
    'node_modules',
    '@cortexkit',
    r.host === 'pi' ? 'pi-claustrum-auth' : 'opencode-claustrum-auth',
  )
}

function credentialIDs(p: string) {
  return p === 'fireworks'
    ? ['fireworks-ai', 'fireworks']
    : p === 'kimi-coding'
      ? ['kimi-for-coding', 'kimi-coding', 'kimi-code-plan-global']
      : [p]
}
export function served(
  p: string,
  id: string,
  status: string,
  refusals: string,
  accounts: string,
) {
  const refusal = refusals
    .split('\n')
    .map((line) => line.trim())
    .find((line) =>
      credentialIDs(p).some((cred) => line.startsWith(`apikey:${cred}:`)),
    )
  if (refusal) return `refused: ${refusal}`
  const state = status
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${id}:`))
  const vault = status
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Vault:'))
  if (vault !== 'Vault: reachable')
    return `refused: ${vault ?? 'discovery unknown'}; ${state ?? 'provider absent'}`
  const states = accountStates(accounts, id)
  if (states.some(eligible))
    return `served: ${state ?? id}; ${states.length} vault account(s)`
  return `refused: ${states.join('; ') || 'no usable vault account'}; ${state ?? 'provider absent'}`
}

function accountStates(accounts: string, id: string) {
  const lines = accounts.split('\n').map((line) => line.trim())
  const index = lines.findIndex(
    (line) => line.startsWith(`${id}:`) && /vault account/.test(line),
  )
  if (index < 0) return []
  const rows = lines.slice(index + 1)
  const end = rows.findIndex((line) => /^\S+: \d+ vault account/.test(line))
  return rows
    .slice(0, end < 0 ? undefined : end)
    .flatMap((line) => line.match(/\]: (.+)$/)?.[1] ?? [])
}
function eligible(state: string) {
  return /^active, enabled(?:,|$)/.test(state) && !state.includes(', declined')
}

function strings(value: unknown): string {
  return typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(strings).join('\n')
      : value && typeof value === 'object'
        ? Object.values(value).map(strings).join('\n')
        : ''
}
interface Driver {
  menu(text: string): Promise<string>
  activate(id: string): Promise<string>
  models(id: string): Promise<Model[]>
  turn(id: string, model: Model, followup?: boolean): Promise<string>
  release(id: string): Promise<string>
  stop(): Promise<void>
}

async function piDriver(r: Runner, extension: string): Promise<Driver> {
  const task = r.start([
    r.binary(),
    '--mode',
    'rpc',
    '--no-session',
    '--offline',
    '-ne',
    '-e',
    extension,
  ])
  const pi = new PiRpc(task.child, true)
  await pi.command({ type: 'set_auto_retry', enabled: false })
  await pi.command({ type: 'set_thinking_level', level: 'off' })
  return {
    menu: (text) => pi.slash(`/claustrum ${text}`),
    activate: (id) => pi.slash(`/claustrum use ${id}`),
    async models(id) {
      const data = await pi.command({ type: 'get_available_models' })
      return ((data?.models ?? []) as Model[]).filter((m) => m.provider === id)
    },
    async turn(id, model) {
      try {
        const result = await pi.turn(
          id,
          model.id,
          'Reply with the single word OK.',
          'off',
        )
        if (result.error) throw new SmokeError(errorClass(result.error))
        return result.text
      } catch (error) {
        await pi.command({ type: 'abort' }).catch(() => {})
        throw error
      }
    },
    release: (id) => pi.slash(`/claustrum release ${id}`),
    async stop() {
      await pi.stop()
    },
  }
}
export function errorClass(text: string) {
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type !== 'error') continue
      const status = event.error?.status
      if (Number.isInteger(status) && status >= 400 && status <= 599)
        return status === 429
          ? 'Provider429'
          : status === 401
            ? 'Provider401'
            : `ProviderHTTP${status}`
      if (event.error?.type === 'output-limit') return 'OutputTokenLimit'
      return 'HostError'
    } catch {}
  }
  if (/insufficient-validity/.test(text))
    return 'insufficient-validity (vault defect)'
  if (/this model.s driver sends its key in[\s\S]*x-api-key/.test(text))
    return 'LocalUnsupportedAuthHeader'
  // Pi errorMessage strings include "412: ..." and "xai API error (403): ...".
  // Match only the status prefix so request identifiers cannot become statuses.
  const status = text.match(/^(?:[\w-]+ API error \()?([45]\d\d)(?:\))?: /)?.[1]
  if (status)
    return status === '429'
      ? 'Provider429'
      : status === '401'
        ? 'Provider401'
        : `ProviderHTTP${status}`
  if (/401|unauthoriz/i.test(text)) return 'Provider401'
  if (/429|rate.?limit/i.test(text)) return 'Provider429'
  if (/timeout|timed out/i.test(text)) return 'Timeout'
  return (
    text.match(
      /\b(?:APICallError|APIError|AuthenticationError|PermissionDeniedError|InvalidRequestError|ModelNotFoundError)\b/,
    )?.[0] ?? 'HostError'
  )
}

async function openCodeDriver(r: Runner): Promise<Driver> {
  const v2 = r.host === 'opencode2'
  const bin = r.binary()
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const ready = path.join(r.o.home, '.live-smoke', r.host, 'guard-ready')
  writeFileSync(ready, '0')
  const task = r.start([
    bin,
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
    '--print-logs',
    '--log-level',
    r.host === 'opencode1' ? 'DEBUG' : 'debug',
  ])
  const api = async (
    method: string,
    route: string,
    body?: unknown,
    timeoutMs = 120_000,
  ): Promise<unknown> => {
    const target = new URL(route, url)
    if (!v2) target.searchParams.set('directory', r.cwd)
    else target.searchParams.set('location[directory]', r.cwd)
    const response = await fetch(target, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${btoa(`opencode:${r.env.OPENCODE_PASSWORD}`)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = Buffer.from(await response.arrayBuffer())
    writeFileSync(
      path.join(r.o.home, '.live-smoke', r.host, `api-${++r.apiSequence}.json`),
      raw,
    )
    // The v1 command hook deliberately returns 500 after its synthetic notice
    // so OpenCode does not follow a handled slash command with a paid turn.
    if (
      !response.ok &&
      !(!v2 && route.endsWith('/command') && response.status === 500)
    )
      throw new SmokeError(`HostHTTP${response.status}`)
    return raw.length ? JSON.parse(raw.toString()) : undefined
  }
  const deadline = Date.now() + 90_000
  let startupError = 'unknown'
  for (;;) {
    if (task.child.exitCode !== null) throw new SmokeError('HostStartupExit')
    if (!`${task.text()}${task.error()}`.includes('server listening')) {
      if (Date.now() > deadline) throw new SmokeError('HostListenTimeout')
      await Bun.sleep(100)
      continue
    }
    try {
      await api('GET', v2 ? '/api/provider' : '/config', undefined, 20_000)
      break
    } catch (error) {
      startupError = failure(error)
    }
    if (Date.now() > deadline)
      throw new SmokeError(`HostStartupTimeout:${startupError}`)
    await Bun.sleep(200)
  }
  const prefix = v2 ? '/api' : ''
  const session = async () => {
    const s = (await api(
      'POST',
      `${prefix}/session`,
      v2
        ? { location: { directory: r.cwd }, title: 'Live smoke' }
        : { title: 'Live smoke' },
    )) as { id?: string; data?: { id: string } }
    const id = s.data?.id ?? s.id
    if (!id) throw new SmokeError('SessionMissingID')
    return id
  }
  let turnSession: string | undefined
  const menu = async (text: string) => {
    const sid = await session()
    await api(
      'POST',
      `${prefix}/session/${sid}/command`,
      v2
        ? { name: 'claustrum', text }
        : { command: 'claustrum', arguments: text },
    )
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      const result =
        strings(
          await api(
            'GET',
            `${prefix}/session/${sid}/${v2 ? 'inbox' : 'message'}`,
          ),
        ) +
        (v2
          ? strings(await api('GET', `${prefix}/session/${sid}/message`))
          : '')
      if (
        /Vault mode:|Refused vault rows:|Accounts \(routing|claustrum-auth|\/claustrum \[/.test(
          result,
        )
      ) {
        const start = result.indexOf('claustrum-auth')
        return start >= 0 ? result.slice(start) : result
      }
      await Bun.sleep(100)
    }
    throw new SmokeError('CommandTimeout')
  }
  return {
    menu,
    async activate(id) {
      if (!v2) return menu(`use ${id}`)
      const result = await r.run([
        bin,
        'auth',
        'login',
        id,
        '--server',
        url,
        '--method',
        'claustrum-auth',
      ])
      if (result.code !== 0)
        throw new SmokeError(
          result.code === 124
            ? 'Timeout'
            : errorClass(result.text + result.error),
        )
      r.vaultIDs.set(id, '')
      const integration = (await api(
        'GET',
        `/api/integration/${encodeURIComponent(id)}`,
      )) as { data: { connections: { type: string; id?: string }[] } }
      const active = integration.data.connections[0]
      if (active?.type !== 'credential' || !active.id)
        throw new SmokeError('ActivatedCredentialMissing')
      r.vaultIDs.set(id, active.id)
      return 'login succeeded'
    },
    async models(id) {
      if (v2) {
        type Priced = Omit<Model, 'cost'> & {
          providerID: string
          cost: (NonNullable<Model['cost']> & { tier?: unknown })[]
          package?: string
          enabled: boolean
        }
        const catalog = (await api('GET', '/api/model')) as { data: Priced[] }
        const providers = (await api('GET', '/api/provider')) as {
          data: { id: string; package?: string }[]
        }
        const provider = providers.data.find((p) => p.id === id)
        return catalog.data
          .filter((m) => m.providerID === id && m.enabled)
          .map((m) => ({
            ...m,
            cost: m.cost.find((c) => !c.tier) ?? m.cost[0],
            api: m.package ?? provider?.package,
          }))
      }
      const catalog = (await api('GET', '/provider')) as { all: V1Provider[] }
      return v1Models(catalog.all.find((p) => p.id === id) ?? { id })
    },
    async turn(id, model, followup = false) {
      if (readFileSync(ready, 'utf8') !== '1')
        throw new SmokeError('RetryGuardNotReady')
      // Bound physical sends, including output-limit continuations, not just
      // retries. A fresh host starts with a spent marker to block stray calls.
      const budget = path.join(
        r.o.home,
        '.live-smoke',
        r.host,
        'turn-budget.json',
      )
      writeFileSync(
        budget,
        JSON.stringify({
          status: 0,
          maxOutputTokens: smokeTokens(model, r.host, id),
        }),
      )
      if (existsSync(`${budget}.spent`)) unlinkSync(`${budget}.spent`)
      if (v2) {
        if (followup && !turnSession) throw new SmokeError('MissingSessionID')
        const result = await r.run([
          bin,
          'run',
          '--server',
          url,
          ...(followup
            ? ['--session', turnSession as string]
            : ['--title', 'Live smoke']),
          '--format',
          'json',
          '--model',
          `${id}/${model.id}${smokeVariant(model) ? `#${smokeVariant(model)}` : ''}`,
          'Reply with the single word OK.',
        ])
        const events = result.text.split('\n').flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
        if (JSON.parse(readFileSync(budget, 'utf8')).exhausted)
          throw new SmokeError('RequestBudgetExhausted')
        if (result.code !== 0 || events.some((e) => e.type === 'error'))
          throw new SmokeError(
            result.code === 124
              ? 'Timeout'
              : errorClass(result.text + result.error),
          )
        const sessions = [
          ...new Set(
            events
              .map((e) => e.sessionID)
              .filter((id): id is string => typeof id === 'string'),
          ),
        ]
        if (sessions.length !== 1)
          throw new SmokeError('MissingOrMixedSessionID')
        if (followup && sessions[0] !== turnSession)
          throw new SmokeError('FollowupSessionMismatch')
        turnSession = sessions[0]
        return (
          events
            .filter((e) => e.type === 'text')
            .map((e) => e.part?.text ?? e.text ?? '')
            .join('') || 'NoAnswerText'
        )
      }
      if (!followup) turnSession = await session()
      // The guard allows one provider request using an exclusive marker file.
      // Polling alone can miss an immediate retry. Abort from the driver, not
      // while waiting inside a host event hook.
      let done = false
      let value: unknown
      let error: unknown
      let retryMessage: string | undefined
      const pending = api('POST', `/session/${turnSession}/message`, {
        model: { providerID: id, modelID: model.id },
        variant: smokeVariant(model),
        parts: [{ type: 'text', text: 'Reply with the single word OK.' }],
        tools: {},
      })
      void pending.then(
        (v) => {
          value = v
          done = true
        },
        (e) => {
          error = e
          done = true
        },
      )
      try {
        while (!done) {
          const states = (await api(
            'GET',
            '/session/status',
            undefined,
            5_000,
          )) as Record<string, { type: string; message?: string }>
          const status = states[turnSession as string]
          if (status?.type === 'retry') {
            retryMessage = status.message ?? 'RetryBlocked'
            break
          }
          await Bun.sleep(25)
        }
      } finally {
        if (!done)
          await api('POST', `/session/${turnSession}/abort`, {}, 10_000).catch(
            () => {},
          )
        await pending.catch(() => {})
      }
      const original = JSON.parse(readFileSync(budget, 'utf8')).status as number
      if (original >= 400)
        throw new SmokeError(
          original === 429
            ? 'Provider429'
            : original === 401
              ? 'Provider401'
              : `ProviderHTTP${original}`,
        )
      if (retryMessage) throw new SmokeError(errorClass(retryMessage))
      if (error) throw error
      const result = value as {
        info?: { error?: unknown }
        parts?: { type: string; text?: string }[]
      }
      if (result.info?.error)
        throw new SmokeError(errorClass(strings(result.info.error)))
      return (
        (result.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('') || 'NoAnswerText'
      )
    },
    async release(id) {
      if (!v2) return menu(`release ${id}`)
      // OpenCode 2 has no /claustrum release. Logout the exact scratch
      // credential activated above, using metadata only, never secret values.
      const credential = r.vaultIDs.get(id)
      if (!credential) {
        if (r.vaultIDs.has(id))
          throw new SmokeError('ActivatedCredentialUnknown')
        return 'not activated; no credential changed'
      }
      const result = await r.run([
        bin,
        'auth',
        'logout',
        id,
        credential,
        '--server',
        url,
      ])
      if (result.code !== 0) throw new SmokeError('LogoutFailed')
      return 'scratch login removed (host logout)'
    },
    async stop() {
      r.kill(task.child)
      await task.done
    },
  }
}

export type TestHooks = {
  binary?: Partial<Record<Host, string>>
  plugin?: Partial<Record<Host, string>>
  env?: Record<string, string>
  config?: Partial<Record<Host, Record<string, unknown>>>
  models?: (models: Model[]) => Model[]
  skipEnrollment?: boolean
  onError?: (error: unknown) => void
}
export async function runSmoke(o: Options, hooks: TestHooks = {}) {
  o = { ...o, home: scratchHome(o.home) }
  const hostEnv = (host: Host) => ({
    ...environment(o.home, o.connection, host),
    ...hooks.env,
  })
  for (const host of o.hosts) hostEnv(host)
  // Inspect existing path topology without opening enrollment or token files.
  files(o.home)
  for (const host of o.hosts) {
    const enrollment =
      host === 'pi'
        ? '.pi/agent/claustrum-auth/pi-enrollment.json'
        : '.local/state/cortexkit/claustrum-auth/opencode/opencode-enrollment.json'
    confined(o.home, path.join(o.home, enrollment))
    if (!hooks.skipEnrollment && !existsSync(path.join(o.home, enrollment)))
      throw new SmokeError(`MissingEnrollment:${host}`)
  }
  if (o.dry) {
    console.log(plan(o))
    return []
  }
  if (!existsSync(o.connection) && !hooks.skipEnrollment)
    throw new SmokeError('MissingConnectionFile')
  const results: { host: Host; report: string; rows: Row[] }[] = []
  for (const host of o.hosts) {
    const env = hostEnv(host)
    const work = path.join(o.home, '.live-smoke', host)
    for (const dir of [
      work,
      path.join(work, 'project'),
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.XDG_STATE_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_RUNTIME_DIR,
      env.TMPDIR,
      env.PI_CODING_AGENT_DIR,
    ])
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(work, 0o700)
    const r = new Runner(o, host, env, hooks.binary)
    const rows: Row[] = []
    let driver: Driver | undefined
    const baseline = stamp(o.home)
    try {
      const initialized = await r.run(['git', 'init', '-q', r.cwd])
      if (initialized.code !== 0) throw new SmokeError('ScratchGitInitFailed')
      const pkg = await install(r)
      const plugin =
        hooks.plugin?.[host] ??
        (host === 'pi' ? path.join(pkg, 'dist/index.js') : pkg)
      if (host !== 'pi') {
        mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true })
        let entry = plugin
        if (lstatSync(plugin).isDirectory()) {
          const manifest = JSON.parse(
            readFileSync(path.join(plugin, 'package.json'), 'utf8'),
          )
          const server = manifest.exports?.['./server']
          // The published server entry uses conditional exports; `main` is
          // the legacy entry and has no OpenCode 2 setup hook.
          const serverEntry =
            typeof server === 'string' ? server : server?.import
          entry = path.resolve(
            plugin,
            host === 'opencode2' && typeof serverEntry === 'string'
              ? serverEntry
              : (manifest.main ?? 'index.js'),
          )
        }
        const original = pathToFileURL(entry).href
        const guard = path.join(work, 'guard')
        const budget = path.join(work, 'turn-budget.json')
        const ready = path.join(work, 'guard-ready')
        mkdirSync(guard, { recursive: true })
        writeFileSync(
          path.join(guard, 'package.json'),
          JSON.stringify({
            name: 'live-smoke-guard',
            type: 'module',
            ...(host === 'opencode2'
              ? {
                  main: './server.js',
                  exports: { '.': './server.js', './server': './server.js' },
                }
              : { main: './index.js', exports: { '.': './index.js' } }),
          }),
        )
        writeFileSync(budget, '{"status":0}')
        writeFileSync(`${budget}.spent`, '')
        // Compose after the original hook instead of relying on plugin order.
        writeFileSync(
          path.join(guard, 'index.js'),
          `
          import original from ${JSON.stringify(original)}
          import {writeFileSync,readFileSync,openSync,closeSync} from 'node:fs'
          const budget=${JSON.stringify(budget)}
          export default {...original,server:async(input,options)=>{
            const hooks=await original.server(input,options)
            return {...hooks,
              'chat.params':async(request,output)=>{await hooks['chat.params']?.(request,output);output.maxOutputTokens=JSON.parse(readFileSync(budget,'utf8')).maxOutputTokens ?? 16},
              config:async(config)=>{
                await hooks.config?.(config)
                for(const block of Object.values(config.provider ?? {})) {
                  const previous=block.options?.fetch
                  if(typeof previous!=='function') continue
                  block.options.fetch=async(...args)=>{
                    try {closeSync(openSync(budget+'.spent','wx',0o600))}
                    catch(error) {if(error.code==='EEXIST') throw new Error('live-smoke request budget exhausted; retries disabled'); throw error}
                    const response=await previous(...args)
                    writeFileSync(budget,JSON.stringify({status:response.status}))
                    return response
                  }
                }
                writeFileSync(${JSON.stringify(ready)},'1')
              }
            }
          }}
        `,
        )
        writeFileSync(
          path.join(guard, 'server.js'),
          `
          import original from ${JSON.stringify(original)}
          import {writeFileSync,openSync,closeSync} from 'node:fs'
          export default {...original,setup:async(ctx,options)=>{
            const dispose=await original.setup(ctx,options)
            const spend=()=>{
              try {closeSync(openSync(${JSON.stringify(`${budget}.spent`)},'wx',0o600))}
              catch(error) {if(error.code==='EEXIST') {writeFileSync(${JSON.stringify(budget)},JSON.stringify({exhausted:true}));throw new Error('live-smoke request budget exhausted; retries and continuations disabled')} throw error}
            }
            const hooks=await Promise.all([
              ctx.session.hook('retry',draft=>{draft.decision={retry:false}}),
              ctx.session.hook('http.request',spend),
              ctx.session.hook('experimental.ws.send',spend),
              ctx.session.hook('title',draft=>{draft.result='Live smoke'}),
            ])
            writeFileSync(${JSON.stringify(ready)},'1')
            return async()=>{for(const hook of hooks) await hook.dispose();if(typeof dispose==='function') await dispose()}
          }}
        `,
        )
        writeFileSync(
          env.OPENCODE_CONFIG,
          JSON.stringify({
            ...hooks.config?.[host],
            [host === 'opencode2' ? 'plugins' : 'plugin']: [
              pathToFileURL(
                host === 'opencode2' ? guard : path.join(guard, 'index.js'),
              ).href,
            ],
          }),
        )
      } else {
        const modelsFile = path.join(env.PI_CODING_AGENT_DIR, 'models.json')
        if (existsSync(modelsFile)) {
          const config = JSON.parse(readFileSync(modelsFile, 'utf8'))
          removeLegacyPiCaps(config)
          writeFileSync(modelsFile, JSON.stringify(config))
        }
        writeFileSync(
          path.join(env.PI_CODING_AGENT_DIR, 'settings.json'),
          JSON.stringify({
            retry: { enabled: false, provider: { maxRetries: 0 } },
          }),
        )
      }
      // Installed dependencies contain example key prefixes, not host output.
      // Baseline only their metadata; never read pre-existing enrollment bytes.
      for (const file of [
        ...files(
          o.home,
          path.join(
            host === 'pi' ? env.PI_CODING_AGENT_DIR : env.OPENCODE_CONFIG_DIR,
            'node_modules',
          ),
        ),
        ...files(o.home, path.join(o.home, '.live-smoke/packs')),
        ...files(o.home, env.npm_config_cache),
      ]) {
        const s = statSync(file)
        baseline.set(file, `${s.size}:${s.mtimeMs}:${s.ctimeMs}`)
      }
      driver =
        host === 'pi' ? await piDriver(r, plugin) : await openCodeDriver(r)
      const selected = o.provider === 'all' ? matrix(host) : [o.provider]
      for (const [at, p] of selected.entries()) {
        const id = providerID(host, p)
        const row: Row = {
          provider: p,
          status: 'not checked',
          activation: 'not attempted',
          turn: 'not attempted',
          extras: '',
          release: 'not attempted',
          leak: 'pending',
        }
        rows.push(row)
        let releaseFailed = false
        try {
          row.status = served(
            p,
            id,
            await driver.menu('status'),
            await driver.menu('refusals'),
            await driver.menu('accounts'),
          )
          if (host === 'opencode2' && p === 'opencode-zen') {
            row.extras = row.status.includes('not-on-this-host')
              ? 'PASS not-on-this-host'
              : 'FAIL expected not-on-this-host'
            row.passed = row.extras.startsWith('PASS')
            continue
          }
          if (!row.status.startsWith('served:')) continue
          await driver.activate(id)
          const ownership = await driver.menu('status')
          if (
            !ownership
              .split('\n')
              .some((line) => line.trim().startsWith(`${id}: owned`))
          )
            throw new SmokeError('ActivationRefused')
          row.activation = 'activated'
          const available = await driver.models(id)
          const models = hooks.models?.(available) ?? available
          const model = cheapest(models, host, p)
          capModels(r, id, p, models)
          await driver.stop()
          driver =
            host === 'pi' ? await piDriver(r, plugin) : await openCodeDriver(r)
          const answer = await driver.turn(id, model)
          if (!answer.trim() || answer === 'NoAnswerText')
            throw new SmokeError('NoAnswerText')
          row.turn = `${preview(answer)} (model: ${model.id})`
          if (p === 'cline-pass')
            row.extras =
              'credential-id classified; refusals clear (verify vault row has no provider id)'
          if (p === 'meta')
            row.extras =
              'one turn only; insufficient-validity is a vault defect; no 401 retry'
          const accounts = await driver.menu('accounts')
          row.extras += `${row.extras ? '; ' : ''}accounts ${accountStates(accounts, id).some(eligible) ? 'active, enabled' : 'FAIL active account missing'}`
          row.passed = !row.extras.includes('FAIL')
        } catch (error) {
          hooks.onError?.(error)
          row.passed = false
          if (row.activation === 'not attempted')
            row.activation = failure(error)
          else row.turn = failure(error)
        } finally {
          if (!(host === 'opencode2' && p === 'opencode-zen')) {
            try {
              row.release = safe(await driver.release(id))
              if (
                /failed|cannot|could not|refus|usage:|\/claustrum \[/i.test(
                  row.release,
                )
              ) {
                row.passed = false
                releaseFailed = true
              }
            } catch (error) {
              row.release = failure(error)
              row.passed = false
              releaseFailed = true
            }
          }
        }
        if (releaseFailed) {
          rows.push(
            ...selected.slice(at + 1).map((provider) => ({
              provider,
              status: 'not checked: earlier release failed',
              activation: 'not attempted',
              turn: 'not attempted',
              extras: '',
              release: 'not attempted',
              leak: 'pending',
              passed: false,
            })),
          )
          break
        }
      }
    } catch (error) {
      hooks.onError?.(error)
      rows.push({
        provider: '(host)',
        status: failure(error),
        activation: 'not attempted',
        turn: 'not attempted',
        extras: '',
        release: 'not attempted',
        leak: 'pending',
      })
    } finally {
      try {
        await driver?.stop()
      } finally {
        await r.stop()
      }
    }
    let leak: string
    try {
      const found = scan(o.home, baseline)
      leak = found.length
        ? found.map((f) => `${f.file}@${f.offset}`).join('; ')
        : 'clean'
    } catch (error) {
      leak = `scan failed: ${failure(error)}`
    }
    for (const row of rows) {
      row.leak = leak
      if (host === 'opencode2' && row.provider === 'xai')
        row.extras += r.httpFallback
          ? '; HTTP fallback logged'
          : '; no HTTP fallback log'
    }
    const report = path.join(
      path.dirname(o.home),
      `results-${host}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
    )
    const markdown = table(host, rows)
    writeFileSync(report, markdown, { mode: 0o600 })
    console.log(markdown)
    results.push({ host, report, rows })
  }
  return results
}
export async function main() {
  try {
    const results = await runSmoke(options(process.argv.slice(2)))
    if (
      results.some((r) =>
        r.rows.some((row) => row.leak !== 'clean' || row.passed !== true),
      )
    )
      process.exitCode = 1
  } catch (error) {
    console.error(safe(failure(error)))
    process.exitCode = 1
  }
}
if (import.meta.main) await main()

function capModels(r: Runner, id: string, provider: string, models: Model[]) {
  const file =
    r.host === 'pi'
      ? path.join(r.env.PI_CODING_AGENT_DIR, 'models.json')
      : r.env.OPENCODE_CONFIG
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const key = r.host === 'opencode1' ? 'provider' : 'providers'
  config[key] ??= {}
  config[key][id] ??= {}
  if (r.host === 'pi') {
    capPiModels(config[key][id], models, provider)
  } else {
    config[key][id].models ??= {}
    for (const model of models)
      config[key][id].models[model.id] = {
        ...config[key][id].models[model.id],
        limit: { ...model.limit, output: smokeTokens(model, r.host, provider) },
      }
  }
  writeFileSync(file, JSON.stringify(config))
}

type PiModelConfig = {
  models?: { id: string; [key: string]: unknown }[]
  modelOverrides?: Record<string, Record<string, unknown>>
}

export function removeLegacyPiCaps(config: {
  providers?: Record<string, PiModelConfig>
}) {
  // Pi treats id/maxTokens-only entries as full custom definitions and supplies
  // defaults that hide catalog prices and reasoning controls. The former cap
  // writer generated that shape; retain definitions with any additional fields.
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    if (provider.models) {
      provider.models = provider.models.filter(
        (m) =>
          !(typeof m.maxTokens === 'number' && Object.keys(m).length === 2),
      )
      // Pi rejects a provider with only an empty models list. Remove empty
      // lists even when read from disk, and drop providers with no settings.
      if (!provider.models.length) delete provider.models
    }
    if (!Object.keys(provider).length) delete config.providers?.[id]
  }
}

export function capPiModels(
  config: PiModelConfig,
  models: Model[],
  provider: string,
) {
  // An override changes the cap without replacing Pi's catalog model metadata.
  config.modelOverrides ??= {}
  for (const model of models)
    config.modelOverrides[model.id] = {
      ...config.modelOverrides[model.id],
      maxTokens: smokeTokens(model, 'pi', provider),
    }
}

type V1Provider = {
  id: string
  npm?: string
  models?: Record<
    string,
    Partial<Omit<Model, 'provider' | 'api'>> & {
      provider?: { npm?: string }
      api?: string | { npm?: string }
    }
  >
}
export function v1Models(provider: V1Provider): Model[] {
  return Object.entries(provider.models ?? {}).map(([id, model]) => ({
    ...model,
    id,
    provider: provider.id,
    api:
      (typeof model.api === 'string' ? model.api : model.api?.npm) ??
      model.provider?.npm ??
      provider.npm ??
      '@ai-sdk/openai-compatible',
  }))
}
