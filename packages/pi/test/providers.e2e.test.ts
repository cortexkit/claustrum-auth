// The shipped supported-provider table on the real Pi CLI, with Pi's own
// catalog and the plugin's real vault path. A models.json override for each
// live provider points its model at a loopback mock with the mock's baseUrl
// and the openai-completions api, so the credential the plugin serves is the
// only thing that reaches the wire.
//
// Only providers Pi itself catalogs can be reached this way: Pi's models.json
// cannot announce a provider its catalog lacks, so the Pi-listed live
// providers are the ones here.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
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
  startPi,
} from './harness.ts'

setDefaultTimeout(120_000)

// The live providers Pi's catalog holds, with the id Pi registers each under.
const live = ['cerebras', 'deepseek', 'fireworks', 'openrouter'] as const

const modelId = 'served-model'

// A models.json provider whose one model uses Pi's bearer api and points at
// the mock; models.json wins over Pi's built-in record for that provider.
function override(origin: string, baseUrl = `${origin}/ok/v1`) {
  return {
    baseUrl,
    api: 'openai-completions',
    models: [{ id: modelId }],
  }
}

async function world(
  models: Record<string, unknown>,
  options: Omit<AgentOptions, 'models'> = {},
) {
  const mock = await mockProvider()
  const vault = await fakeVault(live.map((id) => row(`apikey:${id}`, id)))
  const agent = await agentDir({ ...options, models })
  const launch = (extra: Partial<PiOptions> = {}) =>
    startPi({
      agent,
      mock,
      vault,
      confirm: true,
      production: true,
      ...extra,
    })
  return { mock, vault, agent, launch }
}

describe.skipIf(!e2e)('live providers on the real Pi host', () => {
  test('an owned live provider sends its vault key to its own origin only', async () => {
    const mock = await mockProvider()
    const models = Object.fromEntries(
      live.map((id) => [id, override(mock.origin)]),
    )
    const { vault, agent, launch } = await world(models)
    const pi = await launch()
    for (const id of live) {
      expect(await pi.slash(`/claustrum use ${id}`)).toContain(
        `${id} now uses keys from the Claustrum vault`,
      )
      // The slot holds this plugin's placeholder for Pi's own id.
      expect(JSON.parse(await readFile(agent.authPath, 'utf8'))[id]?.key).toBe(
        placeholderOf(id),
      )
      expect(await pi.turn(id, modelId)).toMatchObject({
        text: 'served-ok',
        error: '',
      })
      expect(mock.seen.at(-1)?.headers.authorization).toBe(
        `Bearer secret-apikey:${id}-1-x`,
      )
      expect(JSON.stringify(mock.seen)).not.toContain(placeholderOf(id))
    }
    expect(vault.reads.sort()).toEqual(live.map((id) => `apikey:${id}`))
    for (const id of live)
      expect(pi.output()).not.toContain(`secret-apikey:${id}-1-x`)
  })

  test('a models.json override to a lookalike origin is refused before the vault is read', async () => {
    const mock = await mockProvider()
    // The mock's base URL is the shipped provider's own scheme and host with a
    // port and a different path: a different origin from the allowlisted one.
    const shipped = new URL('https://api.cerebras.ai')
    const lookalike = `https://api.cerebras.ai.invalid:8443`
    const models = {
      cerebras: override(mock.origin, `${lookalike}/ok/v1`),
    }
    expect(new URL(lookalike).origin).not.toBe(shipped.origin)
    const { vault, agent, launch } = await world(models)
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
    const mock = await mockProvider()
    const { agent, vault, launch } = await world({
      cerebras: override(mock.origin),
    })
    // The vault serves deepseek and openrouter only.
    vault.rows.splice(
      vault.rows.findIndex((entry) => entry.id === 'apikey:cerebras'),
      1,
    )
    const pi = await launch()
    // Activation checks the vault first, so no placeholder is written and the
    // provider's requests never enter the plugin's fetch.
    expect(await pi.slash('/claustrum use cerebras')).not.toContain(
      'now uses keys from the Claustrum vault',
    )
    expect(
      JSON.parse(await readFile(agent.authPath, 'utf8')).cerebras?.key ?? '',
    ).not.toBe(placeholderOf('cerebras'))
    expect(vault.reads).toEqual([])
  })
})
