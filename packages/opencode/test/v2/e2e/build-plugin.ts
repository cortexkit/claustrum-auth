import { existsSync } from 'node:fs'
import { cp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bundleOptions,
  runtimeExternals,
} from '../../../../../scripts/build-options.ts'
import pluginPackage from '../../../package.json'

async function installedPackage(name: string, from: string) {
  let folder = path.dirname(Bun.resolveSync(name, from))
  while (true) {
    const manifest = path.join(folder, 'package.json')
    if (existsSync(manifest)) {
      const contents = JSON.parse(await readFile(manifest, 'utf8'))
      if (contents.name === name) return realpath(folder)
    }
    const parent = path.dirname(folder)
    if (parent === folder)
      throw new Error(`cannot locate package ${name} from ${from}`)
    folder = parent
  }
}

async function copyPackage(
  name: string,
  from: string,
  modules: string,
  ancestors = new Map<string, string>(),
) {
  const source = await installedPackage(name, from)
  if (ancestors.get(name) === source) return
  const destination = path.join(modules, name)
  // Copy package contents, including native prebuilds, without retaining any
  // workspace links. Resolve production dependencies from the source package
  // so both hoisted and isolated installs retain the versions they actually use.
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => path.basename(file) !== 'node_modules',
  })
  const manifest = JSON.parse(
    await readFile(path.join(source, 'package.json'), 'utf8'),
  )
  const next = new Map(ancestors).set(name, source)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPackage(
      dependency,
      source,
      path.join(destination, 'node_modules'),
      next,
    )
  }
}

export async function buildPlugin(
  outdir: string,
  options: {
    copyDependencies?: boolean
    /** Called as each build phase ends, for a test's phase clock. */
    mark?: (label: string) => void
  } = {},
) {
  const build = await Bun.build({
    ...bundleOptions,
    entrypoints: [fileURLToPath(new URL('./plugin-entry.ts', import.meta.url))],
    outdir,
    naming: 'index.js',
  })
  options.mark?.('bundle')
  if (!build.success)
    throw new Error(`plugin bundle failed: ${build.logs.join('\n')}`)
  await writeFile(
    path.join(outdir, 'package.json'),
    JSON.stringify({
      name: pluginPackage.name,
      version: pluginPackage.version,
      type: 'module',
      main: './index.js',
    }),
  )

  if (process.platform === 'win32' || options.copyDependencies) {
    for (const name of runtimeExternals) {
      await copyPackage(
        name,
        path.dirname(fileURLToPath(import.meta.url)),
        path.join(outdir, 'node_modules'),
      )
      options.mark?.(`copy ${name}`)
    }
  } else {
    await symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      path.join(outdir, 'node_modules'),
      'junction',
    )
    options.mark?.('link dependencies')
  }
  return build
}
