import { expect, test } from 'bun:test'
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeExternals } from '../../../../../scripts/build-options.ts'
import { buildPlugin } from './build-plugin.ts'
import { describePlugin } from './diagnostics.ts'

async function expectNoLinks(folder: string) {
  for (const name of await readdir(folder)) {
    const file = path.join(folder, name)
    const stat = await lstat(file)
    expect(stat.isSymbolicLink()).toBe(false)
    if (stat.isDirectory()) await expectNoLinks(file)
  }
}

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
    for (const name of runtimeExternals) {
      const resolved = Bun.resolveSync(name, path.dirname(output.path))
      if (process.platform === 'win32') {
        expect(await realpath(resolved)).toBe(
          await realpath(
            path.join(root, 'plugin', 'node_modules', name, 'dist', 'index.js'),
          ),
        )
      } else {
        expect(resolved).toBe(fileURLToPath(import.meta.resolve(name)))
      }
    }
  } catch (error) {
    console.error(describePlugin(path.join(root, 'plugin')))
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the real-folder fixture resolves externals and transitive dependencies without links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc2 plugin~build-'))
  const plugin = path.join(root, 'plugin')
  try {
    await buildPlugin(plugin, { copyDependencies: true })
    const modules = path.join(plugin, 'node_modules')
    expect((await lstat(modules)).isSymbolicLink()).toBe(false)
    await expectNoLinks(modules)
    // Keep spaces and Windows short-path tildes literal: an encoded file-URL
    // parent can fail Bun's explicit-parent lookup even for real directories.
    for (const name of runtimeExternals) {
      const folder = path.join(modules, name)
      expect((await lstat(folder)).isSymbolicLink()).toBe(false)
      const resolved = Bun.resolveSync(name, plugin)
      expect(await realpath(resolved)).toBe(
        await realpath(path.join(folder, 'dist', 'index.js')),
      )
      expect(await readFile(resolved)).toEqual(
        await readFile(fileURLToPath(import.meta.resolve(name))),
      )
    }
    const client = Bun.resolveSync('@cortexkit/claustrum-client', plugin)
    const store = Bun.resolveSync('@cortexkit/store', path.dirname(client))
    expect(
      path
        .relative(await realpath(plugin), await realpath(store))
        .startsWith('..'),
    ).toBe(false)
    const probe = path.join(plugin, 'probe.mjs')
    await writeFile(
      probe,
      runtimeExternals
        .map((name) => `await import(${JSON.stringify(name)});`)
        .join('\n'),
    )
    const child = Bun.spawn([process.execPath, probe], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = new Response(child.stderr).text()
    const stdout = new Response(child.stdout).text()
    expect({
      exit: await child.exited,
      stderr: await stderr,
      stdout: await stdout,
    }).toEqual({ exit: 0, stderr: '', stdout: '' })

    const installed = fileURLToPath(
      new URL('../prebuilds/', import.meta.resolve('@cortexkit/private-files')),
    )
    const copied = path.join(
      modules,
      '@cortexkit',
      'private-files',
      'prebuilds',
    )
    const files = (await readdir(installed, { recursive: true })).sort()
    const addons = files.filter((file) => file.endsWith('.node'))
    expect(addons.length).toBeGreaterThan(0)
    expect((await readdir(copied, { recursive: true })).sort()).toEqual(files)
    for (const addon of addons) {
      expect(await readFile(path.join(copied, addon))).toEqual(
        await readFile(path.join(installed, addon)),
      )
    }
  } catch (error) {
    console.error(describePlugin(plugin))
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
