// The core fakes clean up after every test in every file of a `bun test`
// run. Bun loads the fakes once per run, so cleanup attached when the fakes
// module loads would reach only the first file that imported it. These tests
// catch that when another file imported the fakes first, as in
// `bun test packages/core/test`, where classification.test.ts loads before
// this file.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fixtureEntries } from '../test-entry.ts'
import { harness, row } from './fakes.ts'

let earlier = ''

test('a scratch folder exists while its test runs', async () => {
  const h = await harness([row('a')])
  earlier = h.dir
  expect(existsSync(earlier)).toBe(true)
})

test('the scratch folder of the previous test is gone', () => {
  expect(earlier).not.toBe('')
  expect(existsSync(earlier)).toBe(false)
})

test('a single-provider harness does not create unrelated roster files', async () => {
  const h = await harness(
    [row('a')],
    'opencode1',
    undefined,
    fixtureEntries.slice(0, 1),
  )
  expect([...h.consumers.keys()]).toEqual(['fixture-a'])
  expect(existsSync(h.hub.rosterPath('fixture-a'))).toBe(true)
  expect(await readdir(dirname(h.hub.rosterPath('fixture-a')))).toEqual([
    'fixture-a.json',
  ])
})
