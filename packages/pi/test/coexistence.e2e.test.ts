// claustrum-auth on one real Pi beside the dedicated CortexKit auth plugins
// (@cortexkit/pi-openai-auth, @cortexkit/pi-anthropic-auth and
// @cortexkit/pi-antigravity-auth, the latest of each from npm). Those plugins
// own openai-codex, anthropic and google; claustrum-auth must leave those
// providers alone, keep serving its own from the fake vault, and keep its
// enrollment and files apart from theirs.
//
// Each dedicated plugin is loaded through a small wrapper that records every
// provider it registers, so the test sees which extension registered what.
// No dedicated plugin is logged in or enrolled with a vault, and their
// enrollment ceremonies need a real Claustrum vault: the test checks that each
// one loads and registers its provider, and that none of them writes beside
// claustrum-auth's enrollment, and goes no further with them.
//
// The plugins are installed with npm into packages/pi/target on first use, so
// this needs the network. CLAUSTRUM_AUTH_PI_PLUGINS_DIR names an existing
// install to reuse instead.
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { reservedProviders } from '../../core/src/providers.ts'
import { executable, launch } from '../../opencode/test/v2/e2e/host.ts'
import {
  agentDir,
  e2e,
  fakeVault,
  filesUnder,
  mockProvider,
  placeholderOf,
  processTree,
  readAuth,
  row,
  secretOf,
  startPi,
  stillRunning,
} from './harness.ts'

// The npm install alone can take a minute on a cold Windows runner.
setDefaultTimeout(300_000)

const dedicated = [
  { plugin: 'pi-openai-auth', provider: 'openai-codex' },
  { plugin: 'pi-anthropic-auth', provider: 'anthropic' },
  { plugin: 'pi-antigravity-auth', provider: 'google' },
] as const

function installPlugins() {
  const reuse = process.env.CLAUSTRUM_AUTH_PI_PLUGINS_DIR
  if (reuse) return reuse
  const dir = path.join(import.meta.dir, '..', 'target', 'dedicated-plugins')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"private":true}\n')
  const npm = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => executable(path.join(entry.replace(/^"|"$/g, ''), 'npm')))
    .find(Boolean)
  if (!npm) throw new Error('npm launcher not found')
  // Pi hands every extension its own pi-ai, pi-tui and pi-coding-agent, so
  // the plugins' peer dependencies are left out.
  const [command, ...args] = launch(npm, [
    'install',
    '--no-audit',
    '--no-fund',
    '--no-save',
    '--omit=peer',
    ...dedicated.map(({ plugin }) => `@cortexkit/${plugin}@latest`),
  ])
  const install = spawnSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  })
  if (install.status !== 0)
    throw new Error(
      `plugin install failed:\n${install.stdout}\n${install.stderr}`,
    )
  return dir
}

/**
 * A wrapper extension that loads one dedicated plugin's Pi entry and appends
 * one line to `log` when it loads and one per provider it registers.
 */
function recorder(dir: string, plugin: string, log: string) {
  const pkg = path.join(dir, 'node_modules', '@cortexkit', plugin)
  const manifest = JSON.parse(
    readFileSync(path.join(pkg, 'package.json'), 'utf8'),
  ) as { version: string; pi: { extensions: string[] } }
  const entry = path.join(pkg, manifest.pi.extensions[0] ?? '')
  const file = path.join(dir, `record-${plugin}.mjs`)
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs'
import plugin from ${JSON.stringify(pathToFileURL(entry).href)}
const record = (value) =>
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ extension: ${JSON.stringify(plugin)}, version: ${JSON.stringify(manifest.version)}, ...value }) + '\\n')
export default function recorded(pi) {
  record({ loaded: true })
  const wrapped = new Proxy(pi, {
    get(target, key) {
      if (key === 'registerProvider')
        return (name, config) => {
          // Pi also takes one object whose id names the provider.
          const id = typeof name === 'string' ? name : name?.id
          const models = (typeof name === 'string' ? config : name)?.models
          record({ name: id, models: models?.map((model) => model.id) ?? null })
          return target.registerProvider(name, config)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return plugin(wrapped)
}
`,
  )
  return file
}

interface Registration {
  extension: string
  version?: string
  loaded?: boolean
  name?: string
  models?: string[] | number | null
}

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Registration)

const relative = (root: string, file: string) =>
  path.relative(root, file).replaceAll('\\', '/')

let pluginsDir = ''

describe.skipIf(!e2e)(
  'claustrum-auth beside the dedicated auth plugins',
  () => {
    beforeAll(() => {
      pluginsDir = installPlugins()
    }, 300_000)

    test('each plugin keeps its own providers and files, and claustrum-auth still serves from the vault', async () => {
      const mock = await mockProvider()
      // Rows for the dedicated plugins' services too: claustrum-auth must not
      // take them even when the vault offers them.
      const vault = await fakeVault([
        row('apikey:cerebras', 'cerebras'),
        row('openai-codex', 'openai', {
          credentialType: 'oauth',
          authMethod: 'chatgpt',
        }),
        row('anthropic-key', 'anthropic'),
        row('google-key', 'google'),
      ])
      const agent = await agentDir({
        models: {
          cerebras: {
            baseUrl: `${mock.origin}/ok/v1`,
            api: 'openai-completions',
            models: [{ id: 'served-model' }],
          },
        },
        auth: { cerebras: { type: 'api_key', key: 'user-key-cerebras' } },
      })
      const paths = hostEnrollmentPaths({ stateDir: agent.state, host: 'pi' })
      const token = readFileSync(paths.tokenPath, 'utf8')
      const claustrumLog = `${agent.home}-claustrum.jsonl`
      const dedicatedLog = `${agent.home}-dedicated.jsonl`
      writeFileSync(claustrumLog, '')
      writeFileSync(dedicatedLog, '')
      const pi = await startPi({
        agent,
        mock,
        vault,
        confirm: true,
        config: { shipped: true, registrations: claustrumLog },
        extensions: [
          ...dedicated.map(({ plugin }) =>
            recorder(pluginsDir, plugin, dedicatedLog),
          ),
          path.join(import.meta.dir, 'coexistence-probe.ts'),
        ],
        // Two of the plugins find Pi's folder through PI_AGENT_DIR rather than
        // PI_CODING_AGENT_DIR. Pointing both at the same folder puts every
        // plugin's files beside claustrum-auth's, as on a default install.
        env: { PI_AGENT_DIR: agent.agent },
      })
      expect(await pi.slash('/claustrum use cerebras')).toContain(
        'cerebras now uses keys from the Claustrum vault',
      )
      expect(await pi.turn('cerebras', 'served-model')).toMatchObject({
        text: 'served-ok',
        error: '',
      })
      expect(mock.seen.map((request) => request.headers.authorization)).toEqual(
        [`Bearer ${secretOf('apikey:cerebras')}`],
      )
      const models = JSON.parse(
        (await pi.slash('/coexist-models')).replace(/^coexist-models /u, ''),
      ) as Record<string, string[]>
      const listed = (await pi.command({ type: 'get_commands' }))?.commands as
        | { name: string }[]
        | undefined
      const commands = (listed ?? []).map((command) => command.name)
      // The dedicated plugins run inside Pi; whatever they started (timers,
      // polls, child processes) must end with it.
      const tree = await processTree(pi.pid)
      console.log(`Pi process tree: ${JSON.stringify(tree)}`)
      expect(tree.map((row) => row.pid)).toContain(pi.pid)
      await pi.stop()
      expect(await stillRunning(tree)).toEqual([])

      // claustrum-auth registered only the shipped table's providers, none of
      // the reserved ones, and never read a reserved row.
      const ours = lines(claustrumLog).map((entry) => entry.name)
      expect(ours).toContain('cerebras')
      for (const reserved of reservedProviders)
        expect(ours).not.toContain(reserved)
      expect(vault.reads).toEqual(['apikey:cerebras'])

      // Every dedicated plugin loaded and registered its provider, and no
      // provider was registered by two extensions.
      const theirs = lines(dedicatedLog)
      console.log(`dedicated plugins: ${JSON.stringify(theirs)}`)
      for (const { plugin, provider } of dedicated) {
        expect(theirs).toContainEqual(
          expect.objectContaining({ extension: plugin, loaded: true }),
        )
        expect(
          theirs
            .filter((entry) => entry.name)
            .filter((entry) => entry.name === provider)
            .map((entry) => entry.extension),
        ).toEqual(expect.arrayContaining([plugin]))
      }
      const owners = new Map<string, Set<string>>()
      for (const entry of [
        ...lines(claustrumLog).map((line) => ({
          name: line.name,
          extension: 'claustrum-auth',
        })),
        ...theirs.filter((entry) => entry.name),
      ])
        owners.set(
          entry.name as string,
          (owners.get(entry.name as string) ?? new Set()).add(entry.extension),
        )
      expect(
        [...owners].filter(([, extensions]) => extensions.size > 1),
      ).toEqual([])

      // Pi still holds the models each plugin last registered for its provider.
      for (const { plugin, provider } of dedicated) {
        const last = theirs
          .filter(
            (entry) => entry.extension === plugin && entry.name === provider,
          )
          .at(-1)
        expect([provider, (models[provider] ?? []).length > 0]).toEqual([
          provider,
          true,
        ])
        if (Array.isArray(last?.models))
          expect([provider, models[provider]]).toEqual([
            provider,
            [...last.models].sort(),
          ])
      }
      expect(commands).toEqual(
        expect.arrayContaining([
          'claustrum',
          'openai',
          'claude',
          'antigravity',
        ]),
      )

      // claustrum-auth's enrollment is its own: the token setup wrote under
      // claustrum-auth is untouched and still enrolls claustrum-auth-pi, and
      // nothing but claustrum-auth wrote into its folder.
      expect(readFileSync(paths.tokenPath, 'utf8')).toBe(token)
      expect(await enrollmentAuthority(paths, 'claustrum-auth-pi')).toBe(
        'vault',
      )
      const files = filesUnder(agent.home).map((file) =>
        relative(agent.home, file),
      )
      console.log(`profile files: ${JSON.stringify(files)}`)
      const ownFolder = `${relative(agent.home, agent.state)}/`
      const own = files.filter((file) => file.startsWith(ownFolder))
      for (const file of own)
        expect(file).toMatch(
          /\/(pi-enrollment(-state)?\.json|pi-activation\.json|pi-slots\/cerebras\.json|rosters\/pi\/[^/]+\/[a-z0-9-]+\.json)$/u,
        )
      for (const { provider } of dedicated)
        expect(own.some((file) => file.includes(provider))).toBe(false)
      // In Pi's own auth.json, claustrum-auth's placeholder sits only in the
      // slot of the provider it serves.
      const auth = await readAuth(agent.authPath)
      expect(auth.cerebras?.key).toBe(placeholderOf('cerebras'))
      for (const [id, entry] of Object.entries(auth))
        if (id !== 'cerebras')
          expect(JSON.stringify(entry)).not.toContain(
            'cortexkit-claustrum-auth',
          )
    })
  },
)
