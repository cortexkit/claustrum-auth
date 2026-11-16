import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { checkSourceSizes } from '../scripts/check-source-size.mjs'

let root: string
beforeEach(() => {
  const scratch = path.resolve('target/scratch/source-size-tests')
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(path.join(scratch, 'checkout-'))
  execFileSync('git', ['init', '-q', root])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function tracked(file: string, lines: number, lastNewline = true) {
  const absolute = path.join(root, file)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(
    absolute,
    'line\n'.repeat(lines - 1) + 'line' + (lastNewline ? '\n' : ''),
  )
  execFileSync('git', ['add', '--', file], { cwd: root })
}

test('rejects a tracked source file at 5000 lines, including a final unterminated line', () => {
  tracked('src/large.ts', 5000, false)
  expect(checkSourceSizes(root)).toEqual([
    'src/large.ts: 5000 lines (limit: fewer than 5000)',
  ])
})

test('exempts test, fixture, declaration and generated files', () => {
  for (const file of [
    'src/a.test.ts',
    'src/a.spec.js',
    'packages/x/test/helper.ts',
    'fixtures/data.ts',
    'src/types.d.ts',
    'src/code.generated.ts',
    'src/generated/code.ts',
  ])
    tracked(file, 5000)
  tracked('src/header.ts', 5000)
  writeFileSync(
    path.join(root, 'src/header.ts'),
    '// @generated\n' + 'line\n'.repeat(4999),
  )
  expect(checkSourceSizes(root)).toEqual([])
})

test('allows an exception at its cap but rejects growth', () => {
  const exceptions = [
    { path: 'src/large.ts', max: 5000, reason: 'Pending split.' },
  ]
  tracked('src/large.ts', 5000)
  expect(checkSourceSizes(root, exceptions)).toEqual([])
  tracked('src/large.ts', 5001)
  expect(checkSourceSizes(root, exceptions)).toEqual([
    'src/large.ts: 5001 lines exceeds exception cap 5000',
  ])
})

test('rejects an exception below the limit or for a missing file', () => {
  const exceptions = [
    { path: 'src/large.ts', max: 5000, reason: 'Pending split.' },
  ]
  tracked('src/large.ts', 4999)
  expect(checkSourceSizes(root, exceptions)).toEqual([
    'src/large.ts: stale exception (4999 lines, below 5000)',
  ])
  rmSync(path.join(root, 'src/large.ts'))
  expect(checkSourceSizes(root, exceptions)).toEqual([
    'src/large.ts: exception file is missing or untracked',
  ])
})
