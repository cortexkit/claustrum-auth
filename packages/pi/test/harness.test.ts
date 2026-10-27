// The harness cleans up after every test in every file of a `bun test` run.
// Bun loads the harness once per run, so cleanup attached when the harness
// module loads would reach only the first file that imported it. These tests
// catch that when another file imported the harness first, as in
// `bun test packages/pi/test`, where coexistence.e2e.test.ts loads before
// this file.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { scratch } from './harness.ts'

let earlier = ''

test('a scratch folder exists while its test runs', async () => {
  earlier = await scratch('cleanup')
  expect(existsSync(earlier)).toBe(true)
})

test('the scratch folder of the previous test is gone', () => {
  expect(earlier).not.toBe('')
  expect(existsSync(earlier)).toBe(false)
})
