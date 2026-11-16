import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const limit = 5000

// Each exception must have a path, its current line count as max, and a reason.
const exceptions = []

function isExempt(file) {
  // Tests and their helpers live in test/ directories; also exempt conventional
  // tests/, __tests__/, fixture/, fixtures/, and __fixtures__/ directories.
  if (
    /(^|\/)(test|tests|__tests__|fixture|fixtures|__fixtures__)(\/|$)/.test(
      file,
    )
  )
    return true
  // These package-root entries expose fixtures only to tests, outside test/.
  if (
    [
      'packages/core/test-entry.ts',
      'packages/pi/test-entry.ts',
      'packages/opencode/setup-test-entry.ts',
    ].includes(file)
  )
    return true
  if (/\.(test|spec)\.[^.]+$/.test(file) || file.endsWith('.d.ts')) return true
  // Generated files also use generated directories or a .generated. filename.
  return (
    /(^|\/)(__generated__|generated|dist|target)(\/|$)/.test(file) ||
    /\.generated\.[^.]+$/.test(file)
  )
}

function lineCount(content) {
  if (!content) return 0
  const newlines = (content.match(/\n/g) || []).length
  return newlines + (content.endsWith('\n') ? 0 : 1)
}

export function checkSourceSizes(root, namedExceptions = exceptions) {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  const tracked = new Set(files)
  const caps = new Map(namedExceptions.map((entry) => [entry.path, entry]))
  const errors = []

  for (const entry of namedExceptions) {
    const absolute = path.join(root, entry.path)
    if (!tracked.has(entry.path) || !existsSync(absolute)) {
      errors.push(`${entry.path}: exception file is missing or untracked`)
      continue
    }
    const count = lineCount(readFileSync(absolute, 'utf8'))
    if (count < limit)
      errors.push(
        `${entry.path}: stale exception (${count} lines, below ${limit})`,
      )
    else if (count > entry.max)
      errors.push(
        `${entry.path}: ${count} lines exceeds exception cap ${entry.max}`,
      )
  }

  for (const file of files) {
    if (
      !/\.(ts|tsx|mts|mjs|js|cjs)$/.test(file) ||
      isExempt(file) ||
      caps.has(file)
    )
      continue
    const content = readFileSync(path.join(root, file), 'utf8')
    // Generators may identify output in an initial comment instead of its path.
    const header = content.split('\n', 10).join('\n')
    if (
      /^\s*(?:\/\/|\/\*|\*)\s*(?:@generated\b|.*\b(?:auto-?generated|do not edit)\b)/im.test(
        header,
      )
    )
      continue
    const count = lineCount(content)
    if (count >= limit)
      errors.push(`${file}: ${count} lines (limit: fewer than ${limit})`)
  }
  return errors
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkSourceSizes(process.cwd())
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else {
    console.log('Source file size check passed.')
  }
}
