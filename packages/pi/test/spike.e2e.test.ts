// The Pi spike: three facts about Pi 1.3.0 that the extension is built on,
// measured on the real Pi CLI. Results per OS are recorded in docs/pi-spike.md.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  agentDir,
  e2e,
  fakeVault,
  mockProvider,
  provider,
  scratch,
  startPi,
} from './harness.ts'

const spikeExtension = path.join(import.meta.dir, 'spike-extension.ts')

async function spikePi(
  models: (origin: string) => Record<string, unknown>,
  auth: Record<string, unknown>,
) {
  const mock = await mockProvider()
  const vault = await fakeVault()
  const agent = await agentDir({
    models: models(mock.origin),
    auth,
    enrolled: false,
  })
  const log = path.join(await scratch('spike-log'), 'log.jsonl')
  writeFileSync(log, '')
  const pi = await startPi({
    agent,
    mock,
    vault,
    extension: spikeExtension,
    env: { SPIKE_LOG: log },
  })
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { pi, mock, entries }
}

describe.skipIf(!e2e)('Pi spike', () => {
  test('fact 1: openai-completions and openai-responses send every request through the caller fetch', async () => {
    const { pi, mock, entries } = await spikePi(
      (origin) => ({
        'spike-completions': provider(origin, [{ id: 'c1' }]),
        'spike-responses': provider(origin, [{ id: 'r1' }], 'openai-responses'),
      }),
      {
        'spike-completions': { type: 'api_key', key: 'user-key-c' },
        'spike-responses': { type: 'api_key', key: 'user-key-r' },
      },
    )
    const completions = await pi.turn('spike-completions', 'c1')
    const responses = await pi.turn('spike-responses', 'r1')
    expect(completions).toMatchObject({ text: 'served-ok', error: '' })
    expect(responses).toMatchObject({ text: 'served-ok', error: '' })
    const fetched = entries().filter((entry) => entry.fetch)
    expect(fetched.map((entry) => entry.fetch)).toEqual([
      'spike-completions',
      'spike-responses',
    ])
    expect(fetched[0].url).toEndWith('/ok/v1/chat/completions')
    expect(fetched[1].url).toEndWith('/ok/v1/responses')
    // The key reaches the caller fetch as an Authorization bearer.
    expect(fetched.map((entry) => entry.authorization)).toEqual([
      'Bearer user-key-c',
      'Bearer user-key-r',
    ])
    // Nothing reached the provider except through the caller fetch.
    expect(
      mock.seen.map((request) => request.headers['x-spike-fetch']),
    ).toEqual(['spike-completions', 'spike-responses'])
  })

  test('fact 2: models.json headers reach the caller fetch beside the bearer', async () => {
    const { pi, mock, entries } = await spikePi(
      (origin) => ({
        'spike-completions': provider(origin, [
          { id: 'h1', headers: { 'x-api-key': 'configured-value' } },
        ]),
      }),
      { 'spike-completions': { type: 'api_key', key: 'user-key-h' } },
    )
    expect(await pi.turn('spike-completions', 'h1')).toMatchObject({
      text: 'served-ok',
    })
    const [fetched] = entries().filter((entry) => entry.fetch)
    expect(fetched).toMatchObject({
      authorization: 'Bearer user-key-h',
      xApiKey: 'configured-value',
    })
    expect(mock.seen[0]?.headers['x-api-key']).toBe('configured-value')
  })

  test('fact 3: only unregistering before re-registering without models restores the built-in and models.json catalog', async () => {
    const { pi, entries } = await spikePi(
      (origin) => ({
        // A user's own model added to a built-in provider with mixed apis.
        fireworks: {
          models: [
            {
              id: 'user-custom-model',
              api: 'openai-completions',
              baseUrl: `${origin}/ok/v1`,
            },
          ],
        },
      }),
      { fireworks: { type: 'api_key', key: 'user-key-f' } },
    )
    const available = await pi.models()
    expect(await pi.slash('/spike-catalog fireworks openai-completions')).toBe(
      'spike-catalog done',
    )
    const [catalog] = entries().filter((entry) => entry.catalog)
    const apis = (models: { api: string }[]) =>
      [...new Set(models.map((model) => model.api))].sort()
    expect(apis(catalog.before)).toEqual([
      'anthropic-messages',
      'openai-completions',
    ])
    expect(
      catalog.before.some(
        (model: { id: string }) => model.id === 'user-custom-model',
      ),
    ).toBe(true)
    expect(apis(catalog.owned)).toEqual(['openai-completions'])
    expect(catalog.owned.length).toBeLessThan(catalog.before.length)
    // Measured on Pi 1.3.0: a re-registration that omits models keeps the
    // previous registration's models, so the owned list stays.
    expect(catalog.merged).toEqual(catalog.owned)
    expect(catalog.restored).toEqual(catalog.before)
    expect(await pi.models()).toEqual(available)
  })
})
