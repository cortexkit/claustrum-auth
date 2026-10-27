// The OpenCode 2 entry on the real host: the pinned `@opencode/cli` runs the
// test build of the entry (plugin-entry.ts) against a loopback mock provider
// and a fake vault, and each case checks what reached the wire, the vault and
// the host's own records. Section 14.2 and the 14.3 HTTP redirect proof of
// the design. It needs the network once to install the CLI, so it runs only
// with CLAUSTRUM_AUTH_OPENCODE2_E2E=1 (its own CI job, on Linux, macOS and
// Windows). CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR may point at a directory that
// already holds the pinned install, to skip it while iterating.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { type FakeVault, startFakeVault, type VaultRow } from './fake-vault.ts'
import {
  executable,
  freePort,
  type HostProcess,
  isolatedEnv,
  isWindows,
  launch,
  spawnHost,
  stopHost,
  within,
} from './host.ts'
import {
  type Behavior,
  type MockProvider,
  startMockProvider,
} from './mock-provider.ts'

const ENABLED = process.env.CLAUSTRUM_AUTH_OPENCODE2_E2E === '1'
const REUSE_CLI_DIR = process.env.CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR
export const OPENCODE_CLI_VERSION = '2.0.32'
const PASSWORD = 'claustrum-auth-e2e-loopback-only'
const METHOD = 'claustrum-auth'

let scratch = ''
let cli = ''
let cliDirectory = ''
let pluginDir = ''

type PluginEvent = { seq: number; at: number; event: string } & Record<
  string,
  unknown
>

/** The providers block of the host config, one per fixture. */
function providerConfig(
  mock: MockProvider,
  extra: Record<string, object> = {},
) {
  const chat = (baseURL: string, more: object = {}) => ({
    package: '@ai-sdk/openai-compatible',
    settings: { baseURL },
    models: { 'mock-model': { name: 'Mock model' } },
    ...more,
  })
  return {
    'fixture-a': chat(`${mock.url}/v1`),
    'fixture-b': chat(
      `${mock.url}/client/v4/accounts/configured-account/ai/v1`,
    ),
    'fixture-c': {
      package: '@ai-sdk/anthropic',
      settings: { baseURL: `${mock.url}/anthropic/v1` },
      models: { 'mock-model': { name: 'Mock model' } },
    },
    'fixture-h': chat(`${mock.url}/v1`, {
      headers: { 'x-api-key': placeholderSecret('fixture-h') },
    }),
    'fixture-o': chat(`${mock.otherURL}/v1`),
    ...extra,
  }
}

class Scenario {
  readonly root: string
  readonly project: string
  readonly env: Record<string, string>
  readonly log: string
  readonly state: string
  readonly hosts: HostProcess[] = []
  readonly outputs: string[] = []
  server?: HostProcess
  serverURL = ''

  private constructor(
    root: string,
    readonly mock: MockProvider,
    readonly vault: FakeVault,
  ) {
    this.root = root
    this.project = path.join(root, 'project')
    mkdirSync(this.project, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: this.project })
    this.log = path.join(root, 'plugin.jsonl')
    writeFileSync(this.log, '')
    // Created by the plugin entry's private writer, as setup does.
    this.state = path.join(root, 'claustrum-state')
    this.env = isolatedEnv(root, {
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_PASSWORD: PASSWORD,
      CLAUSTRUM_AUTH_E2E_VAULT: vault.url,
      CLAUSTRUM_AUTH_E2E_STATE: this.state,
      CLAUSTRUM_AUTH_E2E_LOG: this.log,
      CLAUSTRUM_AUTH_E2E_ORIGIN: mock.url,
    })
    const config = { plugins: [pluginDir], providers: providerConfig(mock) }
    const dir = path.join(this.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify(config, null, 2),
    )
  }

  static async create(rows: VaultRow[], options: { offline?: boolean } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'claustrum-auth-oc2-'))
    const vault = startFakeVault(rows)
    vault.offline = options.offline ?? false
    return new Scenario(root, await startMockProvider(), vault)
  }

  async start() {
    const port = await freePort()
    this.serverURL = `http://127.0.0.1:${port}`
    this.server = spawnHost(
      'host serve',
      launch(cli, [
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
        '--print-logs',
        '--log-level',
        'info',
      ]),
      { cwd: this.project, env: this.env },
    )
    this.hosts.push(this.server)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (this.server.child.exitCode !== null)
        throw new Error(
          `host exited early with ${this.server.child.exitCode}\n${this.describe()}`,
        )
      try {
        const response = await fetch(this.serverURL, {
          // Windows may retry a refused loopback connection for two seconds.
          signal: AbortSignal.timeout(5_000),
        })
        await response.body?.cancel()
        // The host sets plugins up lazily, for the first request bound to a
        // project directory (a login or a turn), so only HTTP is awaited.
        return
      } catch {}
      await Bun.sleep(250)
    }
    throw new Error(`host did not start\n${this.describe()}`)
  }

  async restart() {
    if (this.server) {
      const problems = await stopHost(this.server)
      if (problems.length) throw new Error(problems.join('; '))
    }
    await this.start()
  }

  async cli(name: string, args: string[]) {
    const host = spawnHost(name, launch(cli, args), {
      cwd: this.project,
      env: this.env,
    })
    this.hosts.push(host)
    const finished = await within(
      Promise.all([host.child.exited, host.drained]),
      120_000,
    )
    if (!finished) await stopHost(host)
    const output = `${host.stdout.join('')}${host.stderr.join('')}`
    this.outputs.push(output)
    return { exit: host.child.exitCode, output }
  }

  login(provider: string) {
    return this.cli(`login ${provider}`, [
      'auth',
      'login',
      provider,
      '--server',
      this.serverURL,
      '--method',
      METHOD,
    ])
  }

  turn(
    provider: string,
    options: { continue?: boolean; message?: string } = {},
  ) {
    return this.cli(`turn ${provider}`, [
      'run',
      '--server',
      this.serverURL,
      '--format',
      'json',
      '--model',
      `${provider}/mock-model`,
      ...(options.continue ? ['--continue'] : []),
      options.message ?? 'Say hello.',
    ])
  }

  async api(method: string, route: string, body?: unknown) {
    const response = await fetch(`${this.serverURL}${route}`, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${method} ${route}: ${response.status} ${text}`)
    return text ? (JSON.parse(text) as unknown) : undefined
  }

  /** Switches the provider's stored credential to the user's own key. */
  useKey(provider: string, key: string) {
    return this.api('POST', '/api/credential', {
      integrationID: provider,
      label: 'user key',
      value: { type: 'key', key },
    })
  }

  async credentials(provider: string) {
    const body = await this.api('GET', '/api/credential')
    const rows = (
      Array.isArray(body) ? body : ((body as { data?: unknown[] })?.data ?? [])
    ) as {
      integrationID: string
      active: boolean
      value: { type: string; key?: string; access?: string; methodID?: string }
    }[]
    return rows
      .filter((row) => row.integrationID === provider && row.active)
      .map((row) => row.value)
  }

  events(name?: string): PluginEvent[] {
    const all = readFileSync(this.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PluginEvent)
    return name ? all.filter((entry) => entry.event === name) : all
  }

  wire(
    filter: { server?: 'mock' | 'other'; kind?: string; path?: RegExp } = {},
  ) {
    return this.mock.records.filter(
      (record) =>
        (!filter.server || record.server === filter.server) &&
        (!filter.kind || record.kind === filter.kind) &&
        (!filter.path || filter.path.test(record.path)),
    )
  }

  describe() {
    return [
      `wire: ${JSON.stringify(this.mock.records.map(({ headers: _, ...rest }) => rest))}`,
      `vault: reads ${JSON.stringify(this.vault.reads)} reports ${JSON.stringify(this.vault.reports)} lists ${this.vault.lists}`,
      `plugin: ${existsSync(this.log) ? readFileSync(this.log, 'utf8') : ''}`,
      ...this.outputs.map(
        (output, index) => `--- command ${index + 1}\n${output.slice(-3000)}`,
      ),
      ...(this.server
        ? [
            `--- server\n${this.server.stdout.join('').slice(-4000)}\n${this.server.stderr.join('').slice(-4000)}`,
          ]
        : []),
    ].join('\n')
  }

  /**
   * Every file the host and the plugin wrote under the scratch profile, and
   * everything every process printed, scanned for `needles`. The profile
   * holds the host's database (stored session errors included) and its logs.
   */
  leaks(needles: readonly string[]) {
    const found: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) visit(file)
        else if (entry.isFile()) {
          const bytes = readFileSync(file)
          for (const needle of needles)
            if (bytes.includes(needle))
              found.push(`${path.relative(this.root, file)}: ${needle}`)
        }
      }
    }
    visit(this.root)
    for (const host of this.hosts)
      for (const needle of needles)
        if (`${host.stdout.join('')}${host.stderr.join('')}`.includes(needle))
          found.push(`${host.name} output: ${needle}`)
    return found
  }

  async stop() {
    const problems: string[] = []
    for (const host of [...this.hosts].reverse())
      problems.push(...(await stopHost(host)))
    await this.mock.stop()
    await this.vault.stop()
    return problems
  }

  async remove() {
    await rm(this.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  }
}

/** Runs a scenario body, prints its evidence when it fails, and cleans up. */
async function scenario(
  rows: VaultRow[],
  body: (run: Scenario) => Promise<void>,
  options: { offline?: boolean } = {},
) {
  const run = await Scenario.create(rows, options)
  let failure: unknown
  try {
    await run.start()
    await body(run)
  } catch (error) {
    failure = error
  }
  const problems = await run.stop()
  if (!failure && problems.length)
    failure = new Error(`cleanup failed: ${problems.join('; ')}`)
  if (failure) {
    console.error(run.describe())
    await run.remove().catch(() => {})
    throw failure
  }
  await run.remove()
}

const placeholders = [
  'fixture-a',
  'fixture-b',
  'fixture-c',
  'fixture-h',
  'fixture-o',
].map(placeholderSecret)
const onWire = (run: Scenario, needle: string) =>
  run.mock.records.filter((record) =>
    record.headers.some(([, value]) => value.includes(needle)),
  )

describe.skipIf(!ENABLED)('claustrum-auth plugin on real OpenCode 2', () => {
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'claustrum-auth-oc2-cli-'))
    const cliDir = REUSE_CLI_DIR ?? path.join(scratch, 'cli')
    if (!REUSE_CLI_DIR) {
      mkdirSync(cliDir, { recursive: true })
      writeFileSync(path.join(cliDir, 'package.json'), '{"private":true}\n')
      // npm, not bun: the CLI package installs its platform binary from a
      // lifecycle script, which bun does not run for untrusted packages.
      const npm = (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((dir) => executable(path.join(dir.replace(/^"|"$/g, ''), 'npm')))
        .find(Boolean)
      if (!npm) throw new Error('npm launcher not found')
      const [command, ...args] = launch(npm, [
        'install',
        '--no-audit',
        '--no-fund',
        '--no-save',
        `@opencode/cli@${OPENCODE_CLI_VERSION}`,
      ])
      const install = spawnSync(command, args, {
        cwd: cliDir,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        env: installEnv(),
      })
      if (install.status !== 0)
        throw new Error(
          `CLI install failed:\n${install.stdout}\n${install.stderr}`,
        )
    }
    cliDirectory = realpathSync.native(cliDir)
    cli =
      executable(
        path.join(cliDirectory, 'node_modules', '.bin', 'opencode2'),
      ) ?? ''
    if (!existsSync(cli)) throw new Error(`no opencode2 binary at ${cli}`)
    const [command, ...args] = launch(cli, ['--version'])
    const version = spawnSync(command, args, {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      env: isolatedEnv(path.join(scratch, 'version-profile')),
    }).stdout.trim()
    if (!version.includes(OPENCODE_CLI_VERSION))
      throw new Error(
        `expected @opencode/cli ${OPENCODE_CLI_VERSION}, found "${version}"`,
      )
    pluginDir = path.join(scratch, 'plugin')
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('./plugin-entry.ts', import.meta.url)),
      ],
      outdir: pluginDir,
      naming: 'index.js',
      target: 'node',
      format: 'esm',
    })
    if (!build.success)
      throw new Error(`plugin bundle failed: ${build.logs.join('\n')}`)
  }, 300_000)

  afterAll(async () => {
    if (scratch)
      await rm(scratch, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      })
  })

  test('the isolated profile resolves home inside the scratch root on every OS', () => {
    const env = isolatedEnv(path.join(scratch, 'profile-probe'))
    const probe = spawnSync(
      process.execPath,
      ['-e', 'console.log(require("node:os").homedir())'],
      {
        env,
        encoding: 'utf8',
      },
    )
    expect(probe.stdout.trim()).toBe(env.HOME)
    expect(env.HOME).not.toBe(homedir())
  })

  test('serving: owned bearer, 429 failover, 401 report, class B, class C, misplaced placeholder, wrong origin, user key, reserved', async () => {
    const rows: VaultRow[] = [
      { id: 'a1', providerIds: ['fixture-a'], accountId: 'acct-a1' },
      { id: 'a2', providerIds: ['fixture-a'], accountId: 'acct-a2' },
      {
        id: 'b1',
        providerIds: ['fixture-b'],
        servedAccountId: 'served-account',
      },
      { id: 'c1', providerIds: ['fixture-c'] },
      { id: 'h1', providerIds: ['fixture-h'] },
      { id: 'o1', providerIds: ['fixture-o'] },
      { id: 'r1', providerIds: ['openai'] },
    ]
    await scenario(rows, async (run) => {
      const { vault } = run
      for (const provider of [
        'fixture-a',
        'fixture-b',
        'fixture-c',
        'fixture-h',
        'fixture-o',
      ]) {
        const login = await run.login(provider)
        expect({ provider, exit: login.exit }).toEqual({ provider, exit: 0 })
        expect(await run.credentials(provider)).toEqual([
          expect.objectContaining({
            type: 'oauth',
            methodID: METHOD,
            access: placeholderSecret(provider),
          }),
        ])
      }
      expect(run.events('registered').at(-1)?.providers).toEqual([
        'fixture-a',
        'fixture-b',
        'fixture-c',
        'fixture-h',
        'fixture-o',
      ])
      // A reserved provider never gets the vault method.
      expect((await run.login('openai')).exit).not.toBe(0)

      // Class A, owned: the vault key in Authorization; the placeholder never.
      expect((await run.turn('fixture-a')).exit).toBe(0)
      const first = run.wire({ kind: 'primary' })
      expect(first.map((record) => record.authorization)).toEqual([
        `Bearer ${vault.secret('a1')}`,
      ])
      expect(vault.reads.filter((id) => id.startsWith('a'))).toEqual(
        run.wire({ path: /chat\/completions$/ }).map(() => 'a1'),
      )

      // Two accounts, the first answers 429 before output: the turn moves on.
      run.mock.next({
        type: 'status',
        status: 429,
        headers: { 'retry-after': '120' },
      })
      const before = run.wire({ kind: 'primary' }).length
      expect((await run.turn('fixture-a')).exit).toBe(0)
      expect(
        run
          .wire({ kind: 'primary' })
          .slice(before)
          .map((record) => record.authorization),
      ).toEqual([
        `Bearer ${vault.secret('a1')}`,
        `Bearer ${vault.secret('a2')}`,
      ])
      expect(
        run.events('limit').filter((entry) => entry.provider === 'fixture-a'),
      ).toHaveLength(1)
      expect(
        run.events('retry').filter((entry) => entry.reason === 'reroute'),
      ).toHaveLength(1)

      // 401: one report for the receipt that request was served (a2, since a1
      // is marked), with its record version; none for any other row.
      vault.version = 3
      run.mock.next({
        type: 'status',
        status: 401,
        body: '{"error":{"message":"bad key"}}',
      })
      await run.turn('fixture-a')
      await Bun.sleep(500)
      expect(vault.reports).toEqual([
        { credentialId: 'a2', providerStatus: 401, recordVersion: 3 },
      ])

      // Class B: the account segment comes from the served receipt.
      expect((await run.turn('fixture-b')).exit).toBe(0)
      const classB = run.wire({ path: /accounts/ })
      expect(classB.length).toBeGreaterThan(0)
      expect(
        classB.every((record) =>
          record.path.startsWith('/client/v4/accounts/served-account/ai/v1/'),
        ),
      ).toBe(true)

      // Class C, misplaced placeholder and wrong origin: refused locally,
      // nothing on the wire, no vault read.
      const sent = run.mock.records.length
      const refusals = {
        'fixture-c': 'only serves keys sent in Authorization',
        'fixture-h': 'carries the key for fixture-h in more than one header',
        'fixture-o': `the vault key for fixture-o is only sent to ${run.mock.url}`,
      }
      for (const [provider, message] of Object.entries(refusals)) {
        const result = await run.turn(provider)
        expect({ provider, refused: result.output.includes(message) }).toEqual({
          provider,
          refused: true,
        })
      }
      // Neither the mock nor the second origin (fixture-o's base URL) saw a request.
      expect(run.mock.records.slice(sent)).toEqual([])
      expect(
        vault.reads.filter((id) => ['c1', 'h1', 'o1'].includes(id)),
      ).toEqual([])

      // The user's own key on a served provider passes unchanged: no vault
      // read, no report.
      const reads = vault.reads.length
      await run.useKey('fixture-a', 'user-key-own')
      expect((await run.turn('fixture-a')).exit).toBe(0)
      expect(run.wire({ kind: 'primary' }).at(-1)?.authorization).toBe(
        'Bearer user-key-own',
      )
      expect(vault.reads.length).toBe(reads)
      expect(vault.reports).toHaveLength(1)
      expect(vault.reads).not.toContain('r1')

      for (const placeholder of placeholders)
        expect(onWire(run, placeholder)).toEqual([])
      expect(run.leaks(rows.map((row) => vault.secret(row.id)))).toEqual([])
    })
  }, 600_000)

  test('redaction and the 14.3 redirect proof: echoed keys, a thrown transport error, cross-origin redirects with controls', async () => {
    await scenario([{ id: 'a1', providerIds: ['fixture-a'] }], async (run) => {
      const { vault, mock } = run
      const secret = vault.secret('a1')
      expect((await run.login('fixture-a')).exit).toBe(0)

      // The key echoed in an error body and in an SSE error event.
      mock.next({ type: 'echo-error' })
      const body = await run.turn('fixture-a')
      mock.next({ type: 'echo-sse' })
      const sse = await run.turn('fixture-a')
      expect(body.output).toContain('invalid key')
      expect(`${body.output}${sse.output}`).not.toContain(secret)

      // A thrown transport error whose URL carries the key: a 307 to
      // another loopback origin with the key in the path, which reads the
      // request line and closes the connection unanswered. The host follows
      // it and fails with a transport error on every retry, until it gives
      // up and shows the error.
      const leak: Behavior = {
        type: 'redirect',
        status: 307,
        location: (bearer) => `${mock.resetURL}/leak/${bearer}`,
      }
      mock.next(...Array.from({ length: 12 }, () => leak))
      const thrown = await run.turn('fixture-a')
      mock.clear()
      // The host did follow the redirect into the closed connection, so the
      // checks below cover a real transport error carrying the key in its URL.
      const followed = mock.resets.filter((line) =>
        line.includes('/leak/<bearer>'),
      )
      expect(followed.length).toBeGreaterThan(0)
      const shown = thrown.output
        .split('\n')
        .filter((line) => line.includes('"type":"error"'))
      console.log(
        `THROWN-TRANSPORT-ERROR-TURN: ${JSON.stringify({
          exit: thrown.exit,
          followed: followed.length,
          shown: shown.map((line) => line.slice(0, 600)),
        })}`,
      )
      expect(shown.length).toBeGreaterThan(0)
      expect(thrown.output).not.toContain(secret)

      // 14.3: every cross-origin redirect status, then the two controls.
      const statuses = [301, 302, 303, 307, 308]
      for (const status of statuses) {
        mock.next({
          type: 'redirect',
          status,
          location: () => `${mock.otherURL}/v1/chat/completions`,
        })
        await run.turn('fixture-a')
      }
      mock.next({
        type: 'redirect',
        status: 307,
        location: () => `${mock.url}/v1/same-origin/chat/completions`,
      })
      await run.turn('fixture-a')
      const other = run.wire({ server: 'other' })
      // The redirects were followed, so the zero below is real.
      expect(other.length).toBeGreaterThanOrEqual(statuses.length)
      expect(
        other.filter((record) =>
          record.headers.some(([, value]) => value.includes(secret)),
        ),
      ).toEqual([])
      const control = run.wire({ path: /same-origin/ })
      expect(control.map((record) => record.authorization)).toEqual([
        `Bearer ${secret}`,
      ])
      expect(
        run
          .wire({ kind: 'primary' })
          .filter((record) => record.behavior === 'ok')
          .every((record) => record.authorization === `Bearer ${secret}`),
      ).toBe(true)

      for (const placeholder of placeholders)
        expect(onWire(run, placeholder)).toEqual([])
      const leaks = run.leaks([secret])
      console.log(`THROWN-TRANSPORT-ERROR: ${JSON.stringify({ leaks })}`)
      expect(leaks).toEqual([])
    })
  }, 600_000)

  test('vault lifecycle: down at start, kept key during an outage, rows vanishing, one list per tick, release and restart', async () => {
    const rows: VaultRow[] = [
      { id: 'a1', providerIds: ['fixture-a'] },
      {
        id: 'b1',
        providerIds: ['fixture-b'],
        servedAccountId: 'served-account',
      },
    ]
    await scenario(
      rows,
      async (run) => {
        const { vault } = run
        // Registered while the vault was down; activation needs no restart.
        const down = await run.login('fixture-a')
        expect(run.events('registered').at(-1)?.providers).toContain(
          'fixture-a',
        )
        expect(down.exit).not.toBe(0)
        expect(down.output).toContain(
          'the Claustrum vault could not be reached',
        )
        expect(await run.credentials('fixture-a')).toEqual([])
        vault.offline = false
        expect((await run.login('fixture-a')).exit).toBe(0)
        expect((await run.login('fixture-b')).exit).toBe(0)
        expect((await run.turn('fixture-a')).exit).toBe(0)

        // Outage after one read: the kept key is served; a provider with no
        // earlier read fails with the unreachable message.
        vault.offline = true
        expect((await run.turn('fixture-a')).exit).toBe(0)
        expect(run.wire({ kind: 'primary' }).at(-1)?.authorization).toBe(
          `Bearer ${vault.secret('a1')}`,
        )
        const sent = run.mock.records.length
        const unreached = await run.turn('fixture-b')
        expect(unreached.output).toContain(
          'the Claustrum vault could not be reached',
        )
        expect(run.mock.records.length).toBe(sent)
        vault.offline = false

        // No vault watch: one list per tick for the whole host, not one per
        // provider. Two members over 21 s at a 5 s tick list at most five
        // times; listing per member would be at least eight.
        const lists = vault.lists
        await Bun.sleep(21_000)
        const window = vault.lists - lists
        expect(window).toBeGreaterThan(0)
        expect(window).toBeLessThanOrEqual(5)

        // Rows vanish while owned: refused locally, nothing sent, the stored
        // placeholder stays.
        vault.rows = []
        await Bun.sleep(7_000)
        const quiet = run.mock.records.length
        const vanished = await run.turn('fixture-a')
        expect(vanished.output).toContain('no vault account for fixture-a')
        expect(run.mock.records.length).toBe(quiet)
        expect(await run.credentials('fixture-a')).toEqual([
          expect.objectContaining({ access: placeholderSecret('fixture-a') }),
        ])

        // Release is the host's own login switch; after a restart nothing
        // re-enters it.
        vault.rows = rows
        await run.useKey('fixture-a', 'user-key-own')
        await run.restart()
        const reads = vault.reads.length
        expect((await run.turn('fixture-a')).exit).toBe(0)
        expect(run.wire({ kind: 'primary' }).at(-1)?.authorization).toBe(
          'Bearer user-key-own',
        )
        expect(vault.reads.length).toBe(reads)
        expect(await run.credentials('fixture-a')).toEqual([
          expect.objectContaining({ type: 'key' }),
        ])

        // The plugin's own files are owner-only on POSIX: the state
        // directory (created by common-auth's private writer, as setup does)
        // is 0700 and every file in it 0600, so no other user reaches them
        // whatever the modes of the roster subdirectories, which are printed
        // for the record. Windows DACLs are checked by common-auth's
        // private-files job, which owns the writers.
        if (!isWindows) {
          const files: string[] = []
          const dirs: string[] = []
          const visit = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name)
              const mode = (statSync(file).mode & 0o777).toString(8)
              if (entry.isDirectory()) {
                dirs.push(`${path.relative(run.state, file)} ${mode}`)
                visit(file)
              } else files.push(`${path.relative(run.state, file)} ${mode}`)
            }
          }
          visit(run.state)
          console.log(`STATE-MODES: ${JSON.stringify({ dirs, files })}`)
          expect((statSync(run.state).mode & 0o777).toString(8)).toBe('700')
          expect(files.length).toBeGreaterThan(1)
          expect(files.filter((entry) => !entry.endsWith(' 600'))).toEqual([])
        }
        expect(run.leaks(rows.map((row) => vault.secret(row.id)))).toEqual([])
      },
      { offline: true },
    )
  }, 600_000)

  test('mixed ownership in one session keeps the host retry decision; terminal-event ordering and the retry hook error are recorded', async () => {
    const rows: VaultRow[] = [
      { id: 'a1', providerIds: ['fixture-a'] },
      { id: 'a2', providerIds: ['fixture-a'] },
      { id: 'h1', providerIds: ['fixture-h'] },
    ]
    await scenario(rows, async (run) => {
      const { vault, mock } = run
      // The session starts on the user's own key (foreign). Its first call
      // gets a 429 with a wait long enough to switch the login to the vault
      // method meanwhile, so the host's retry of the same turn goes out
      // owned, and that one gets a 429 too.
      expect((await run.login('fixture-a')).exit).toBe(0)
      await run.useKey('fixture-a', 'user-key-own')
      mock.next(
        { type: 'status', status: 429, headers: { 'retry-after': '8' } },
        { type: 'status', status: 429, headers: { 'retry-after': '1' } },
      )
      const turn = run.turn('fixture-a')
      expect(await mock.waitForPrimaries(1)).toBe(true)
      expect((await run.login('fixture-a')).exit).toBe(0)
      const result = await turn
      const primaries = run.wire({ kind: 'primary' })
      const owned = primaries.filter((record) =>
        record.authorization?.includes('vault-secret'),
      )
      expect(primaries[0]?.authorization).toBe('Bearer user-key-own')
      expect(owned.length).toBeGreaterThan(0)
      const retries = run
        .events('retry')
        .filter((entry) => entry.provider === 'fixture-a')
      // The owned 429 in a mixed session: the host decides, nothing reroutes.
      expect(retries.length).toBeGreaterThan(0)
      expect(retries.every((entry) => entry.reason === 'host-decides')).toBe(
        true,
      )
      for (const entry of retries)
        expect(entry.decision).toEqual(entry.hostDecision)
      console.log(
        `MIXED-OWNERSHIP: ${JSON.stringify({
          exit: result.exit,
          primaries: primaries.map((record) =>
            record.authorization?.includes('vault-secret')
              ? 'owned'
              : 'foreign',
          ),
          retries: retries.map((entry) => entry.reason),
          limits: run.events('limit').map((entry) => entry.accountId),
        })}`,
      )

      // The misplaced-placeholder refusal, and what the host's retry hook is
      // handed for it, if it runs at all.
      expect((await run.login('fixture-h')).exit).toBe(0)
      const refused = await run.turn('fixture-h')
      const hostRetries = run
        .events('host-retry')
        .filter((entry) => entry.provider === 'fixture-h')
      console.log(
        `PLACEMENT-REFUSED-RETRY: ${JSON.stringify({
          exit: refused.exit,
          shown: refused.output.includes(
            'carries the key for fixture-h in more than one header',
          ),
          hostRetries: hostRetries.map((entry) => entry.error),
        })}`,
      )

      // Terminal-event ordering, over every session of this run, with three
      // back-to-back turns of one session for busy-period transitions.
      for (const index of [1, 2, 3])
        expect(
          (await run.turn('fixture-a', { continue: index > 1 })).exit,
        ).toBe(0)
      console.log(`RESET-PROOF: ${JSON.stringify(resetProof(run.events()))}`)
      expect(vault.reads.length).toBeGreaterThan(0)
    })
  }, 600_000)
})

/**
 * What the plugin observed about the host's busy periods, per session: every
 * transport hook call should fall between a `session.execution.started` and
 * its terminal event (part a of the reset proof), and after the k-th prompt
 * of a session, the first transport should only come once the terminal event
 * of the previous busy period has arrived (part b).
 */
function resetProof(events: PluginEvent[]) {
  type State = {
    busy: boolean
    terminals: number
    prompts: number
    checked: boolean
  }
  const sessions = new Map<string, State>()
  const outside: unknown[] = []
  const late: unknown[] = []
  let transitions = 0
  for (const entry of events) {
    const sessionID = String(entry.sessionID)
    const state = sessions.get(sessionID) ?? {
      busy: false,
      terminals: 0,
      prompts: 0,
      checked: true,
    }
    sessions.set(sessionID, state)
    if (entry.event === 'prompt') {
      state.prompts++
      state.checked = false
    } else if (entry.event === 'execution') {
      if (entry.type === 'session.execution.started') state.busy = true
      else {
        state.terminals++
        state.busy = false
      }
    } else if (entry.event === 'transport') {
      if (!state.busy)
        outside.push({ seq: entry.seq, kind: entry.kind, sessionID })
      if (!state.checked && state.prompts > 1) {
        transitions++
        if (state.terminals < state.prompts - 1)
          late.push({ seq: entry.seq, kind: entry.kind, sessionID })
      }
      state.checked = true
    }
  }
  return {
    sessions: sessions.size,
    timeline: Object.fromEntries(
      [...sessions.keys()].map((sessionID) => [
        sessionID.slice(-6),
        events
          .filter((entry) => String(entry.sessionID) === sessionID)
          .map((entry) =>
            entry.event === 'execution'
              ? String(entry.type).replace('session.execution.', '')
              : entry.event === 'transport'
                ? `transport:${entry.kind}`
                : entry.event,
          )
          .filter(
            (token) =>
              !['select', 'limit', 'host-retry', 'retry'].includes(token),
          )
          .join(' '),
      ]),
    ),
    transports: events.filter((entry) => entry.event === 'transport').length,
    terminals: events.filter(
      (entry) =>
        entry.event === 'execution' &&
        entry.type !== 'session.execution.started',
    ).length,
    transportsOutsideBusyPeriod: outside,
    busyPeriodTransitions: transitions,
    transportsBeforePreviousTerminal: late,
  }
}

/**
 * npm's environment: an isolated profile (the CLI's install script may run
 * the binary) that keeps the runner's own proxy settings, so the pinned
 * package can still be fetched.
 */
function installEnv() {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...isolatedEnv(path.join(scratch, 'install-profile')),
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
  ]) {
    if (process.env[key] === undefined) delete env[key]
    else env[key] = process.env[key]
  }
  return env
}
