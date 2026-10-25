import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertExternalImports,
  assertImportShape,
  assertNoChunks,
  checkExternalProbe,
} from '../scripts/check-externals.ts'
import { checkInstalledRanges } from '../scripts/check-installed-ranges.mjs'
import {
  assertNoFixtureEntries,
  assertPackageContents,
  checkPackageContents,
} from '../scripts/check-package-contents.mjs'
import {
  checkPortability,
  portabilityViolations,
} from '../scripts/check-portability.mjs'

test('installed-range checker refuses a mismatched published dependency', async () => {
  const scratch = path.join(import.meta.dir, '..', 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(path.join(scratch, 'ranges-'))
  try {
    await mkdir(path.join(root, 'packages'))
    await mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true })
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '^2.0.0' } }),
    )
    await writeFile(
      path.join(root, 'node_modules', 'fixture', 'package.json'),
      JSON.stringify({ version: '1.0.0' }),
    )
    expect(() => checkInstalledRanges(root)).toThrow(
      'outside the declared ^2.0.0',
    )
    await writeFile(
      path.join(root, 'node_modules', 'fixture', 'package.json'),
      JSON.stringify({ version: '2.0.1' }),
    )
    expect(checkInstalledRanges(root)).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('portability fence rejects nonportable paths and POSIX permissions', () => {
  const unsafe = [
    'const file = base + "/auth.json";',
    `const file = \`\${base}/auth.json\`;`,
    'const file = parts.join("/");',
    'const file = segments.join("/");',
    'const file = ".config/opencode";',
    'const file = "~";',
    'const file = "~/auth.json";',
    'const file = "C:\\\\state";',
    'const permissions = 0o600;',
    'const permissions = "0700";',
    'writeFile(file, data, { mode: 384 });',
    'fs.chmodSync(file, permissions);',
  ]
  for (const source of unsafe)
    expect(portabilityViolations(source).length, source).toBeGreaterThan(0)
})

test('portability fence accepts path.join and common-auth imports', () => {
  const source = `
    import path from "node:path";
    import os from "node:os";
    import { atomicWriteJson } from "@cortexkit/common-auth/fs";
    export { writer } from "./writer.js";
    const file = path.join(os.homedir(), ".config", "opencode", "auth.json");
    const command = "/claustrum";
    const origin = "https://example.com/v1";
    const handshake = "wss://example.com";
    const segments = url.pathname.split('/');
    url.pathname = segments.join('/');
  `
  expect(portabilityViolations(source)).toEqual([])
})

test('plugin source passes the portability fence', () => {
  expect(() => checkPortability()).not.toThrow()
})

test('production bundler keeps all three runtime dependencies external', async () => {
  await checkExternalProbe()
})

test('external checker rejects missing bare imports and lazy imports', () => {
  const source = [
    'export * as vault from "@cortexkit/claustrum-client";',
    'export * as subc from "@cortexkit/subc-client";',
    'export const files = () => import("@cortexkit/private-files");',
  ]
  expect(() => assertExternalImports(source.join('\n'))).not.toThrow()
  for (let index = 0; index < source.length; index++) {
    expect(() =>
      assertExternalImports(
        source.filter((_, position) => position !== index).join('\n'),
      ),
    ).toThrow('was not kept external')
  }
  expect(() =>
    assertExternalImports(`${source.join('\n')}\nimport("./lazy.js");`),
  ).toThrow('Lazy imports')
})

test('dynamic import exception allows only the private-files literal', () => {
  expect(() =>
    assertImportShape('import("@cortexkit/private-files")'),
  ).not.toThrow()
  for (const code of [
    'import("@cortexkit/claustrum-client")',
    'import("@cortexkit/subc-client")',
    'import("other")',
    'import("./lazy.js")',
    'import(specifier)',
  ])
    expect(() => assertImportShape(code)).toThrow('Lazy imports')
})

test('private-files static imports and reexports are refused', () => {
  for (const code of [
    'import * as files from "@cortexkit/private-files";',
    'export * from "@cortexkit/private-files";',
  ])
    expect(() => assertImportShape(code)).toThrow('never statically')
})

test('bundle output checker rejects lazy chunks and test entries', () => {
  const files = ['index.js', 'index.d.ts', 'server.js', 'server.d.ts']
  expect(() => assertNoChunks(files, ['index', 'server'])).not.toThrow()
  expect(() =>
    assertNoChunks([...files, 'chunk-123.js'], ['index', 'server']),
  ).toThrow('Unexpected bundle outputs')
  expect(() =>
    assertNoChunks([...files, 'test-entry.js'], ['index', 'server']),
  ).toThrow('test entries')
})

test('package checker rejects test entries and tests in tarballs', () => {
  const files = ['package.json', 'dist/index.js', 'dist/index.d.ts']
  expect(() => assertPackageContents(files, 'fixture')).not.toThrow()
  for (const extra of [
    'test-entry.ts',
    'test/entry.test.ts',
    'dist/test-entry.js',
    'dist/entry.test.js',
  ]) {
    expect(() => assertPackageContents([...files, extra], 'fixture')).toThrow(
      'unexpected published files',
    )
  }
})

test('package checker rejects fixture code hidden in production bundles', () => {
  expect(() => assertNoFixtureEntries('const table = []')).not.toThrow()
  expect(() => assertNoFixtureEntries('const service = "fixture-a"')).toThrow(
    'Fixture providers',
  )
})

test('publishable npm tarballs exclude the test entry and tests', async () => {
  await checkPackageContents()
}, 30_000)
