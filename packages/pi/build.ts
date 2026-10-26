import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bundleOptions } from '../../scripts/build-options.ts'

// Pi's extension loader hands every extension its own copy of these modules
// (jiti aliases under Node, virtual modules in the compiled binary). Bundling
// them would load a second pi-ai whose api registry and model catalog Pi never
// sees, so they stay bare imports in the published bundle.
export const piHostModules = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/compat',
  '@earendil-works/pi-coding-agent',
]

export async function buildPiBundle(entry: string, outdir: string) {
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    ...bundleOptions,
    external: [...bundleOptions.external, ...piHostModules],
    entrypoints: [entry],
    outdir,
  })
  if (!result.success)
    throw new AggregateError(result.logs, `${entry} failed to build`)
  return result.outputs.map((output) => output.path)
}

// tsc writes one declaration file per source file; the package publishes only
// the entry's, so it must not refer to the others.
async function copyEntryDeclaration(dist: string) {
  const declaration = await readFile(
    path.join(import.meta.dir, 'target', 'types', 'index.d.ts'),
    'utf8',
  )
  if (/from ['"]\.|import\(['"]\./u.test(declaration))
    throw new Error('dist/index.d.ts must not import other source files')
  await writeFile(path.join(dist, 'index.d.ts'), declaration)
}

if (import.meta.main) {
  const dist = path.join(import.meta.dir, 'dist')
  await buildPiBundle(path.join(import.meta.dir, 'src', 'index.ts'), dist)
  await copyEntryDeclaration(dist)
  console.log('pi: built 1 static ESM entry.')
}
