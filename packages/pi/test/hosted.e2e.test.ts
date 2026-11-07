import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  agentDir,
  e2e,
  fakeVault,
  mockProvider,
  piBundles,
  placeholderOf,
  provider,
  readAuth,
  row,
  secretOf,
  startPi,
} from './harness.ts'
import { waitForPlaceholder } from './scenario.ts'
import { shippedRelay } from './shipped-relay.ts'

describe.skipIf(!e2e)('hosted real Pi', () => {
  test('host marker and shipped-client relay serve a vault row on the wire without enrollment', async () => {
    const mock = await mockProvider()
    const vault = await fakeVault([row('hosted-key', 'fixture-a')])
    const agent = await agentDir({
      enrolled: false,
      models: { 'fixture-a': provider(mock.origin, [{ id: 'ok' }]) },
      auth: { 'fixture-a': { type: 'api_key', key: 'seeded-user-key' } },
      flags: { 'fixture-a': { consented: true } },
    })
    const relay = await shippedRelay(agent.home, vault.url)
    const bundle = await piBundles()
    const wrapper = path.join(agent.home, 'hosted-extension.mjs')
    await writeFile(
      wrapper,
      `
      import { ClaustrumClient } from ${JSON.stringify(import.meta.resolve('@cortexkit/claustrum-client'))};
      import extension from ${JSON.stringify(pathToFileURL(bundle.test).href)};
      globalThis[Symbol.for('cortexkit.vault')] = (pluginId) => {
        if (pluginId !== 'claustrum-auth') throw new Error('wrong plugin identity');
        let pending;
        const get = () => pending ??= ClaustrumClient.connect({ connectionFile: ${JSON.stringify(relay.connectionFile)}, logger: () => {} });
        // The relay uses its host transport, never the plugin's empty token argument.
        return {
          listScoped: async () => (await get()).listScoped(),
          getScoped: async ({ enrollmentToken: _pluginToken, ...input }) => (await get()).getScoped(input),
          reportAuthFailureScoped: async ({ enrollmentToken: _pluginToken, ...input }) => (await get()).reportAuthFailureScoped(input),
          close: async () => { if (pending) (await pending).close(); },
        };
      };
      export default extension;
    `,
    )
    const pi = await startPi({
      agent,
      mock,
      vault,
      extension: wrapper,
      config: { forbidNativeConnect: true },
      env: { CORTEXKIT_VAULT_HOST: 'thalamus' },
    })
    await waitForPlaceholder(agent.authPath, 'fixture-a')
    expect(await pi.slash('/claustrum')).toContain('Served by Thalamus')
    const turn = await pi.turn('fixture-a', 'ok')
    expect({
      errors: relay.errors,
      methods: relay.methods,
      reads: vault.reads,
      wire: mock.seen.map((request) => request.headers.authorization),
    }).toMatchObject({
      errors: [],
      reads: ['hosted-key'],
      wire: [`Bearer ${secretOf('hosted-key')}`],
    })
    expect(turn).toMatchObject({ text: 'served-ok', error: '' })
    expect(mock.seen.length).toBeGreaterThan(0)
    expect(mock.seen.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${secretOf('hosted-key')}`,
    ])
    expect(
      mock.seen.some((request) =>
        JSON.stringify(request).includes(placeholderOf('fixture-a')),
      ),
    ).toBe(false)
    expect(vault.reads).toEqual(['hosted-key'])
    expect(relay.methods).toContain('credential.list_scoped')
    expect(relay.methods).toContain('credential.get_scoped')
    await expect(
      readFile(path.join(agent.state, 'pi-enrollment.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await pi.slash('/claustrum release fixture-a')
    expect((await readAuth(agent.authPath))['fixture-a']).toEqual({
      type: 'api_key',
      key: 'seeded-user-key',
    })
  }, 120_000)
})
