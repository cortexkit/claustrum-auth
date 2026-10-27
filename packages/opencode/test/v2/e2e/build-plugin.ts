import { symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleOptions } from '../../../../../scripts/build-options.ts'

export async function buildPlugin(outdir: string) {
  const build = await Bun.build({
    ...bundleOptions,
    entrypoints: [fileURLToPath(new URL('./plugin-entry.ts', import.meta.url))],
    outdir,
    naming: 'index.js',
  })
  if (!build.success)
    throw new Error(`plugin bundle failed: ${build.logs.join('\n')}`)

  // The Windows private-files addon lives beside its package's JS loader.
  // Keep production's externals intact and resolvable from the scratch plugin.
  await symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(outdir, 'node_modules'),
    'junction',
  )
  return build
}
