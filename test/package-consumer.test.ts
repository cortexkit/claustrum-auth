import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  assertDeclaredExternals,
  assertPackageContents,
  assertPackageEntries,
} from '../scripts/check-package-contents.mjs'

const root = path.resolve(import.meta.dir, '..')
const scratch = path.join(root, 'target', 'scratch')

test('package checker refuses undeclared runtime imports and missing export targets', () => {
  const pkg = {
    name: 'fixture',
    dependencies: { '@cortexkit/common-auth': '*' },
  }
  expect(() =>
    assertDeclaredExternals(pkg, 'import "@cortexkit/common-auth/fs"'),
  ).not.toThrow()
  expect(() =>
    assertDeclaredExternals(pkg, 'import "@cortexkit/claustrum-client"'),
  ).toThrow('undeclared runtime external')
  expect(() =>
    assertDeclaredExternals(
      { ...pkg, peerDependencies: { '@earendil-works/pi-ai': '>=1.3.0' } },
      'import "@earendil-works/pi-ai"',
    ),
  ).not.toThrow()
  expect(() =>
    assertPackageEntries(
      { ...pkg, exports: { './server': './dist/server.js' } },
      [{ path: 'dist/index.js' }],
    ),
  ).toThrow('missing published entry ./dist/server.js')
})

for (const name of ['opencode', 'pi']) {
  test(`packed ${name} installs with host peers and imports on plain Node without workspace fallbacks`, () => {
    mkdirSync(scratch, { recursive: true })
    const directory = mkdtempSync(path.join(scratch, `consumer-${name}-`))
    try {
      const consumer = path.join(directory, 'consumer')
      const profile = path.join(directory, 'profile')
      mkdirSync(consumer)
      mkdirSync(profile)
      const npmrc = path.join(profile, 'npmrc')
      writeFileSync(npmrc, '')
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: profile,
        USERPROFILE: profile,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
        npm_config_userconfig: npmrc,
        npm_config_cache: path.join(directory, 'cache'),
        npm_config_update_notifier: 'false',
      }
      function run(command: string, args: string[], cwd: string) {
        const result = spawnSync(command, args, {
          cwd,
          env,
          encoding: 'utf8',
          shell: process.platform === 'win32' && command === 'npm',
          timeout: 90_000,
        })
        if (result.status !== 0)
          throw new Error(
            `${command} ${args.join(' ')} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
          )
        return result.stdout
      }
      const [pack] = JSON.parse(
        run(
          'npm',
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            directory,
          ],
          path.join(root, 'packages', name),
        ),
      ) as { filename: string; files: { path: string }[] }[]
      assertPackageContents(pack.files, name)
      writeFileSync(
        path.join(consumer, 'package.json'),
        '{"private":true,"type":"module"}',
      )
      const sourcePackage = JSON.parse(
        readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8'),
      )
      const hostPeers = Object.keys(sourcePackage.peerDependencies ?? {})
        .filter((peer) => !sourcePackage.peerDependenciesMeta?.[peer]?.optional)
        .map((peer) => {
          const version = sourcePackage.devDependencies?.[peer]
          if (!version)
            throw new Error(`Missing pinned test host peer: ${peer}`)
          return `${peer}@${version}`
        })
      // Supply the same pinned peers as the real test hosts, without workspace
      // links. Runtime dependencies must come from the tarball's declarations.
      run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          path.join(directory, pack.filename),
          ...hostPeers,
        ],
        consumer,
      )
      const packageName = `@cortexkit/${name}-claustrum-auth`
      const installed = path.join(
        consumer,
        'node_modules',
        '@cortexkit',
        `${name}-claustrum-auth`,
      )
      const pkg = JSON.parse(
        readFileSync(path.join(installed, 'package.json'), 'utf8'),
      )
      assertPackageEntries(pkg, pack.files)
      for (const dependency of Object.keys(pkg.dependencies))
        expect(
          existsSync(
            path.join(
              consumer,
              'node_modules',
              ...dependency.split('/'),
              'package.json',
            ),
          ),
        ).toBe(true)
      expect(
        existsSync(
          path.join(
            consumer,
            'node_modules',
            '@cortexkit',
            'claustrum-auth-core',
          ),
        ),
      ).toBe(false)
      for (const file of pack.files.filter((file) => file.path.endsWith('.js')))
        assertDeclaredExternals(
          pkg,
          readFileSync(path.join(installed, file.path), 'utf8'),
        )
      // Deny reads outside the installed consumer, including this checkout's
      // ancestor node_modules. An undeclared dependency cannot pass by accident.
      const source =
        name === 'opencode'
          ? `const root = await import('${packageName}'); const server = await import('${packageName}/server'); console.log(JSON.stringify([typeof root.default.server, typeof server.default.setup, server.default.id]));`
          : `const extension = await import('${packageName}'); console.log(JSON.stringify([typeof extension.default]));`
      const output = run(
        'node',
        [
          '--permission',
          `--allow-fs-read=${consumer}`,
          '--input-type=module',
          '-e',
          source,
        ],
        consumer,
      )
      expect(JSON.parse(output)).toEqual(
        name === 'opencode'
          ? ['function', 'function', 'cortexkit.claustrum-auth']
          : ['function'],
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
}
