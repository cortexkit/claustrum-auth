import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
const semver = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
)
const installPin =
  /(@cortexkit\/(?:opencode|pi)-claustrum-auth)@\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?(?:\+[0-9a-zA-Z.-]+)?/gu

export function validateVersion(version) {
  if (
    typeof version !== 'string' ||
    version.trim() !== version ||
    !semver.test(version)
  )
    throw new Error(`Invalid semver: '${version}'`)
}

function documentation(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory()
      ? documentation(filename)
      : entry.name.endsWith('.md')
        ? [filename]
        : []
  })
}

export function syncVersion(version, { directory = root, check = false } = {}) {
  validateVersion(version)
  const edits = []
  for (const name of ['opencode', 'pi']) {
    const filename = path.join(directory, 'packages', name, 'package.json')
    const current = readFileSync(filename, 'utf8')
    const pkg = JSON.parse(current)
    pkg.version = version
    edits.push([filename, current, `${JSON.stringify(pkg, null, 2)}\n`])
  }
  for (const filename of [
    path.join(directory, 'README.md'),
    ...['opencode', 'pi'].map((name) =>
      path.join(directory, 'packages', name, 'README.md'),
    ),
    ...documentation(path.join(directory, 'docs')),
  ]) {
    if (!existsSync(filename)) continue
    const current = readFileSync(filename, 'utf8')
    edits.push([
      filename,
      current,
      current.replace(installPin, `$1@${version}`),
    ])
  }
  const changed = edits.filter(([, current, next]) => current !== next)
  if (check && changed.length)
    throw new Error(
      `Tag/version mismatch in: ${changed.map(([filename]) => path.relative(directory, filename)).join(', ')}`,
    )
  for (const [filename, , next] of changed) {
    writeFileSync(filename, next)
    console.log(`Synced ${path.relative(directory, filename)} to ${version}`)
  }
  return changed.length
}

if (import.meta.main) {
  const [version, option, ...extra] = process.argv.slice(2)
  if (
    !version ||
    extra.length ||
    (option !== undefined && !['--validate', '--check'].includes(option))
  )
    throw new Error('Usage: version-sync.mjs <version> [--validate|--check]')
  validateVersion(version)
  if (option !== '--validate')
    syncVersion(version, { check: option === '--check' })
}
