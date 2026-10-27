import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPlugin } from './build-plugin.ts'

test('the real-host fixture keeps the Windows native loader in its installed package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc2-plugin-build-'))
  try {
    const build = await buildPlugin(path.join(root, 'plugin'))
    expect(build.outputs).toHaveLength(1)
    const output = build.outputs[0]
    if (!output) throw new Error('no fixture bundle')
    const source = await output.text()
    // Inlining moves import.meta.url to scratch and breaks ../prebuilds/*.node.
    expect(source.includes('../prebuilds/')).toBe(false)
    expect(/from ["']@cortexkit\/claustrum-client["']/.test(source)).toBe(true)
    for (const name of [
      '@cortexkit/claustrum-client',
      '@cortexkit/subc-client',
      '@cortexkit/private-files',
    ]) {
      expect(import.meta.resolve(name, pathToFileURL(output.path).href)).toBe(
        import.meta.resolve(name),
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
