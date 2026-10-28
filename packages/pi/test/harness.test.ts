// The harness cleans up after every test in every file of a `bun test` run.
// Bun loads the harness once per run, so cleanup attached when the harness
// module loads would reach only the first file that imported it. These tests
// catch that when another file imported the harness first, as in
// `bun test packages/pi/test`, where coexistence.e2e.test.ts loads before
// this file.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { removeScratchDir, scratch } from './harness.ts'

let earlier = ''

test('a scratch folder exists while its test runs', async () => {
  earlier = await scratch('cleanup')
  expect(existsSync(earlier)).toBe(true)
})

test('the scratch folder of the previous test is gone', () => {
  expect(earlier).not.toBe('')
  expect(existsSync(earlier)).toBe(false)
})

function busyError() {
  return Object.assign(new Error('resource busy or locked'), {
    code: 'EBUSY',
  })
}

test('a Windows sharing violation is retried until the folder is gone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-remove-'))
  await writeFile(path.join(dir, 'file.txt'), 'x')
  let calls = 0
  const retries: { code: string; attempt: number }[] = []
  await removeScratchDir(dir, {
    platform: 'win32',
    intervalMs: 1,
    onRetry: (retry) => retries.push(retry),
    remove: async (target) => {
      // The first two removals hit the transient hold; the third goes through.
      if (++calls <= 2) throw busyError()
      await rm(target, { recursive: true, force: true })
    },
  })
  expect(existsSync(dir)).toBe(false)
  expect(calls).toBe(3)
  expect(retries.map((retry) => retry.code)).toEqual(['EBUSY', 'EBUSY'])
  expect(retries.map((retry) => retry.attempt)).toEqual([1, 2])
})

test('a lasting Windows sharing violation still fails loudly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-remove-'))
  const retries: string[] = []
  const failure = await removeScratchDir(dir, {
    platform: 'win32',
    budgetMs: 50,
    intervalMs: 5,
    onRetry: (retry) => retries.push(retry.code),
    remove: async () => {
      throw busyError()
    },
  }).then(
    () => 'removed',
    (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? 'unknown',
  )
  expect(failure).toBe('EBUSY')
  // Every wait was reported, so an unbroken run of retries marks a real hold.
  expect(retries.length).toBeGreaterThan(0)
  expect(retries.every((code) => code === 'EBUSY')).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test('other errors and other platforms are not retried', async () => {
  let windowsCalls = 0
  await expect(
    removeScratchDir('missing', {
      platform: 'win32',
      intervalMs: 1,
      remove: async () => {
        windowsCalls++
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      },
    }),
  ).rejects.toThrow('gone')
  expect(windowsCalls).toBe(1)
  let posixCalls = 0
  await expect(
    removeScratchDir('missing', {
      platform: 'darwin',
      intervalMs: 1,
      remove: async () => {
        posixCalls++
        throw busyError()
      },
    }),
  ).rejects.toThrow('resource busy or locked')
  expect(posixCalls).toBe(1)
})
