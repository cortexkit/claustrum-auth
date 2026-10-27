import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { bundleOptions } from './build-options.ts'

export async function buildPackage(name: string) {
  const directory = path.join(import.meta.dir, '..', 'packages', name)
  const dist = path.join(directory, 'dist')
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  const entries =
    name === 'opencode' ? ['index', 'server', 'setup-bin'] : ['index']
  for (const entry of entries) {
    const result = await Bun.build({
      ...bundleOptions,
      entrypoints: [path.join(directory, 'src', `${entry}.ts`)],
      outdir: dist,
    })
    if (!result.success)
      throw new AggregateError(result.logs, `${name}/${entry} failed to build`)
  }
  console.log(`${name}: built ${entries.length} static ESM entries.`)
}

if (import.meta.main) {
  const name = process.argv[2]
  if (!name || !['opencode', 'pi'].includes(name))
    throw new Error('Expected opencode or pi')
  await buildPackage(name)
}
