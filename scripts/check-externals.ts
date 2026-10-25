import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript-api'
import { bundleOptions } from './build-options.ts'

const requiredRuntimeExternals = [
  '@cortexkit/claustrum-client',
  '@cortexkit/subc-client',
  '@cortexkit/private-files',
]

export function assertExternalImports(source: string) {
  const file = ts.createSourceFile(
    'bundle.js',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const imports = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      throw new Error('Lazy imports are forbidden in plugin bundles')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const name of requiredRuntimeExternals) {
    if (!imports.has(name)) throw new Error(`${name} was not kept external`)
  }
}

export function assertNoChunks(files: string[], entries: string[]) {
  const expected = new Set(
    entries.flatMap((entry) => [`${entry}.js`, `${entry}.d.ts`]),
  )
  const unexpected = files.filter((file) => !expected.has(file))
  if (unexpected.length)
    throw new Error(
      `Unexpected bundle outputs (lazy chunks or test entries): ${unexpected.join(', ')}`,
    )
  for (const entry of entries) {
    if (!files.includes(`${entry}.js`))
      throw new Error(`Missing bundle entry: ${entry}`)
  }
}

export async function checkExternalProbe(root = process.cwd()) {
  const scratch = path.join(root, 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, 'external-probe-'))
  // The plugin entries do not yet import the external runtime dependencies.
  // Exercise the production options with those packages so an unused external
  // list cannot pass unnoticed.
  await symlink(
    path.join(root, 'packages', 'core', 'node_modules'),
    path.join(directory, 'node_modules'),
    'junction',
  )
  const entry = path.join(directory, 'entry.ts')
  await writeFile(
    entry,
    requiredRuntimeExternals
      .map(
        (name, index) =>
          `export * as dependency${index} from ${JSON.stringify(name)};`,
      )
      .join('\n'),
  )
  try {
    const result = await Bun.build({
      ...bundleOptions,
      entrypoints: [entry],
      outdir: path.join(directory, 'dist'),
    })
    if (!result.success)
      throw new AggregateError(result.logs, 'External probe failed to build')
    const [output] = result.outputs
    if (!output || result.outputs.length !== 1)
      throw new Error('External probe emitted lazy chunks')
    assertExternalImports(await output.text())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function checkExternals(root = process.cwd()) {
  await checkExternalProbe(root)
  for (const [name, entries] of [
    ['opencode', ['index', 'server']],
    ['pi', ['index']],
  ] as const) {
    const dist = path.join(root, 'packages', name, 'dist')
    assertNoChunks(await readdir(dist), [...entries])
    for (const entry of entries) {
      const source = await readFile(path.join(dist, `${entry}.js`), 'utf8')
      if (/import\s*\(/u.test(source))
        throw new Error(`${name}: lazy import in ${entry}`)
    }
  }
  console.log(
    'External boundary passed: claustrum-client, subc-client and private-files remain bare imports; no lazy chunks.',
  )
}

if (import.meta.main) await checkExternals()
