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
import { createFetch } from '../src/index.ts'
import { fixtureEntries, supportedProviders } from '../test-entry.ts'
import {
  bearer,
  harness,
  placeholder,
  row,
  testLifetime,
  vaultRowFor,
  withProviderHarness,
} from './fakes.ts'

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

test('a shipped-provider origin harness commits only its own roster', async () => {
  const entry = supportedProviders[0]
  const member = entry.hosts.opencode1 as string
  const credential = vaultRowFor(entry)
  await withProviderHarness([credential], 'opencode1', entry, async (h) => {
    expect([...h.consumers.keys()]).toEqual([member])
    expect(h.consumer.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
      credential.id,
    ])
    expect(await readdir(dirname(h.hub.rosterPath(member)))).toEqual([
      `${member}.json`,
    ])
  })
})

test('harness teardown aborts and drains its fetch before disposing the roster', async () => {
  const lifetime = testLifetime()
  const h = await harness(undefined, undefined, undefined, fixtureEntries, {
    beforeDispose: lifetime.close,
  })
  const started = Promise.withResolvers<void>()
  let abortedWithRoster = false
  let settled = false
  const work = lifetime.run(async (signal) => {
    const fetch = createFetch({
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
      fetch: async (input) => {
        const outbound = input as Request
        return await new Promise<Response>((_resolve, reject) => {
          outbound.signal.addEventListener(
            'abort',
            () => {
              abortedWithRoster = h.consumer.snapshot() !== undefined
              reject(outbound.signal.reason)
            },
            { once: true },
          )
          started.resolve()
        })
      },
    })
    try {
      await fetch('https://fixture.invalid', { headers: bearer, signal })
    } finally {
      settled = true
    }
  })
  try {
    await started.promise
    await h.close()
    expect(abortedWithRoster).toBe(true)
    expect(settled).toBe(true)
    await expect(h.hub.refresh()).rejects.toMatchObject({ kind: 'closed' })
    await work
  } finally {
    await lifetime.close()
    await work
  }
})

test('a harness lifetime closed during setup never starts its late fetch', async () => {
  const lifetime = testLifetime()
  const started = Promise.withResolvers<void>()
  const setup = Promise.withResolvers<void>()
  let sends = 0
  const work = lifetime.run(async (signal) => {
    started.resolve()
    await setup.promise
    signal.throwIfAborted()
    sends++
  })
  await started.promise
  const close = lifetime.close()
  setup.resolve()
  await close
  await work
  expect(sends).toBe(0)
  expect(lifetime.signal.aborted).toBe(true)
})
