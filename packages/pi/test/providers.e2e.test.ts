// The shipped supported-provider table on the real Pi CLI, with Pi's own
// catalog and the plugin's vault path against the fake vault. The test build
// serves the shipped table with the mock's loopback origin added to each entry
// (the published bundle connects to a real Claustrum daemon, never to the fake
// vault). A models.json override for each live provider points its model at
// the mock with the bearer api Pi registers for that provider, so the
// credential the plugin serves is the only thing that reaches the wire.
//
// Only providers Pi itself catalogs can be reached this way: Pi's models.json
// cannot announce a provider its catalog lacks, so the Pi-listed live
// providers are the ones here.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentOptions,
  agentDir,
  anyFileContains,
  e2e,
  fakeVault,
  mockProvider,
  type PiOptions,
  placeholderOf,
  row,
  secretOf,
  startPi,
} from './harness.ts'

setDefaultTimeout(120_000)

// The live providers Pi's catalog holds: the id Pi registers each under, the
// vault row that serves it with the fleet's provider id, and the bearer api
// the plugin registers for it (the api most of Pi's own models of it use).
const live = [
  { pi: 'cerebras', credential: 'apikey:cerebras', fleet: 'cerebras' },
  { pi: 'deepseek', credential: 'apikey:deepseek', fleet: 'deepseek' },
  // The fleet id is fireworks-ai; Pi's own id is fireworks.
  { pi: 'fireworks', credential: 'apikey:fireworks-ai', fleet: 'fireworks-ai' },
  // The fleet id names Kimi's coding plan; Pi's id is kimi-coding.
  {
    pi: 'kimi-coding',
    credential: 'apikey:kimi-for-coding',
    fleet: 'kimi-code-plan-global',
  },
  { pi: 'openrouter', credential: 'apikey:openrouter', fleet: 'openrouter' },
  {
    pi: 'meta',
    credential: 'oauth:meta',
    fleet: 'meta',
    oauth: true,
    api: 'openai-responses',
  },
  {
    pi: 'xai',
    credential: 'oauth:xai',
    fleet: 'xai',
    oauth: true,
    api: 'openai-responses',
  },
  { pi: 'opencode-go', credential: 'apikey:opencode-go', fleet: 'opencode-go' },
  {
    pi: 'opencode',
    credential: 'apikey:opencode-zen',
    fleet: 'opencode',
    api: 'openai-responses',
  },
] as const

const modelId = 'served-model'

// A models.json provider whose one model uses Pi's bearer api for it and
// points at the mock; models.json wins over Pi's built-in record for that
// provider.
function override(
  origin: string,
  baseUrl = `${origin}/ok/v1`,
  api = 'openai-completions',
) {
  return {
    baseUrl,
    api,
    models: [{ id: modelId }],
  }
}

const vaultRows = () =>
  live.map((item) =>
    row(item.credential, item.fleet, {
      ...('oauth' in item
        ? {
            credentialType: 'oauth',
            authMethod: 'oauth',
            categories: ['llm-provider', `${item.fleet}-native`],
          }
        : {}),
    }),
  )

// The mock, the fake vault holding every live row, and a Pi agent folder
// whose models.json is built against the mock's origin. Pi is launched with
// the test build serving the shipped table.
async function world(
  models: (origin: string) => Record<string, unknown>,
  options: Omit<AgentOptions, 'models'> = {},
) {
  const mock = await mockProvider()
  const vault = await fakeVault(vaultRows())
  const agent = await agentDir({ ...options, models: models(mock.origin) })
  const launch = (extra: Partial<PiOptions> = {}) =>
    startPi({
      agent,
      mock,
      vault,
      confirm: true,
      config: { shipped: true },
      ...extra,
    })
  return { mock, vault, agent, launch }
}

describe.skipIf(!e2e)('live providers on the real Pi host', () => {
  // Pi ships for Node: its `pi` launcher is `dist/bundle/cli.js` with a
  // `#!/usr/bin/env node` line (npm's `pi.cmd` on Windows runs it with node),
  // and the harness starts that same file with node. The extension reports
  // the runtime it was loaded in, so every OS in CI shows that the provider
  // tests below ran under Node and not under Bun, which runs the test itself.
  test.skipIf(Boolean(process.env.CLAUSTRUM_AUTH_PI_RUNTIME))(
    'Pi loads the extension under Node, as its own launcher does',
    async () => {
      const { agent, launch } = await world((origin) => ({
        cerebras: override(origin),
      }))
      const runtime = `${agent.home}-runtime.jsonl`
      const pi = await launch({ config: { shipped: true, runtime } })
      expect(await pi.slash('/claustrum use cerebras')).toContain(
        'cerebras now uses keys from the Claustrum vault',
      )
      expect(await pi.turn('cerebras', modelId)).toMatchObject({
        text: 'served-ok',
        error: '',
      })
      const [loaded, ...more] = (await readFile(runtime, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              execPath: string
              versions: Record<string, string>
            },
        )
      console.log(`Pi extension runtime: ${JSON.stringify(loaded)}`)
      expect(more).toEqual([])
      expect(loaded?.versions.bun).toBeUndefined()
      expect(loaded?.versions.node).toMatch(/^\d+\.\d+\.\d+$/u)
      expect(path.basename(loaded?.execPath ?? '').toLowerCase()).toMatch(
        /^node(\.exe)?$/u,
      )
    },
  )

  test('an owned live provider sends its vault key to its own origin only', async () => {
    const { mock, vault, agent, launch } = await world((origin) =>
      Object.fromEntries(
        live.map((item) => [
          item.pi,
          override(origin, undefined, 'api' in item ? item.api : undefined),
        ]),
      ),
    )
    const pi = await launch()
    for (const item of live) {
      expect([item.pi, await pi.slash(`/claustrum use ${item.pi}`)]).toEqual([
        item.pi,
        expect.stringContaining(
          `${item.pi} now uses keys from the Claustrum vault`,
        ),
      ])
      // The slot holds this plugin's placeholder for Pi's own id.
      expect(
        JSON.parse(await readFile(agent.authPath, 'utf8'))[item.pi]?.key,
      ).toBe(placeholderOf(item.pi))
      expect([item.pi, await pi.turn(item.pi, modelId)]).toEqual([
        item.pi,
        expect.objectContaining({ text: 'served-ok', error: '' }),
      ])
      expect(mock.seen.at(-1)?.headers.authorization).toBe(
        `Bearer ${secretOf(item.credential)}`,
      )
      expect(JSON.stringify(mock.seen)).not.toContain(placeholderOf(item.pi))
    }
    expect(vault.reads.sort()).toEqual(
      live.map((item) => item.credential).sort(),
    )
    for (const item of live)
      expect(pi.output()).not.toContain(secretOf(item.credential))
  })

  test('a models.json override to a lookalike origin is refused before the vault is read', async () => {
    // The override's base URL is the shipped provider's own scheme and host
    // with a port and another suffix: a different origin from the allowed one.
    const shipped = new URL('https://api.cerebras.ai')
    const lookalike = `https://api.cerebras.ai.invalid:8443`
    expect(new URL(lookalike).origin).not.toBe(shipped.origin)
    const { vault, agent, launch } = await world((origin) => ({
      cerebras: override(origin, `${lookalike}/ok/v1`),
    }))
    const pi = await launch()
    expect(await pi.slash('/claustrum use cerebras')).toContain(
      'cerebras now uses keys from the Claustrum vault',
    )
    const result = await pi.turn('cerebras', modelId)
    expect(result.text).toBe('')
    expect(result.error).toContain('https://api.cerebras.ai')
    expect(result.error).not.toContain('secret-apikey:cerebras')
    expect(vault.reads).toEqual([])
    expect(
      JSON.parse(await readFile(agent.authPath, 'utf8')).cerebras.key,
    ).toBe(placeholderOf('cerebras'))
    expect(await anyFileContains(agent.home, 'secret-apikey:cerebras')).toEqual(
      [],
    )
  })

  test('a live provider the vault has no row for is not activated, so nothing is sent', async () => {
    const { agent, vault, launch } = await world((origin) => ({
      cerebras: override(origin),
      deepseek: override(origin),
    }))
    // The vault serves every live row except cerebras.
    vault.rows.splice(
      vault.rows.findIndex((entry) => entry.id === 'apikey:cerebras'),
      1,
    )
    const pi = await launch()
    // Activation checks the vault first, so no placeholder is written and the
    // provider's requests never enter the plugin's fetch.
    expect(await pi.slash('/claustrum use cerebras')).toContain(
      'The Claustrum vault serves no usable account for cerebras',
    )
    expect(
      JSON.parse(await readFile(agent.authPath, 'utf8')).cerebras?.key ?? '',
    ).not.toBe(placeholderOf('cerebras'))
    // The same vault does serve a provider it has a row for, so the refusal
    // above comes from the missing row, not an unreachable vault.
    expect(await pi.slash('/claustrum use deepseek')).toContain(
      'deepseek now uses keys from the Claustrum vault',
    )
    expect(vault.lists).toBeGreaterThan(0)
    expect(vault.reads).toEqual([])
  })
})
