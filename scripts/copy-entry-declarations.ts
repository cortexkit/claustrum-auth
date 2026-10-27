// Copies a package's public entry declarations into its dist directory.
// TypeScript emits a declaration for every source file it compiles, internal
// modules included, so a package's declaration build writes to
// target/declarations/<package> and only the entries named here are shipped.
// An entry declaration that imports a relative path would point at a file
// that is not shipped, so the copy is refused.
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export function relativeImports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]*)['"]/g,
    ),
  ].map((match) => match[1])
}

export async function copyEntryDeclarations(name: string, entries: string[]) {
  const root = path.join(import.meta.dir, '..')
  const from = path.join(root, 'target', 'declarations', name)
  const dist = path.join(root, 'packages', name, 'dist')
  await mkdir(dist, { recursive: true })
  for (const entry of entries) {
    const source = path.join(from, `${entry}.d.ts`)
    const imports = relativeImports(await readFile(source, 'utf8'))
    if (imports.length)
      throw new Error(
        `${name}/${entry}.d.ts imports unshipped files: ${imports.join(', ')}`,
      )
    await copyFile(source, path.join(dist, `${entry}.d.ts`))
  }
  console.log(`${name}: shipped declarations for ${entries.join(', ')}.`)
}

if (import.meta.main) {
  const [name, ...entries] = process.argv.slice(2)
  if (!name || !entries.length)
    throw new Error('Expected a package name and its entry names')
  await copyEntryDeclarations(name, entries)
}
