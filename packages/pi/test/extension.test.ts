import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { FlagStore } from '../src/flags.ts'
import extension from '../src/index.ts'
import { bearerApi, ownedModels } from '../src/models.ts'
import { scratch } from './harness.ts'

const model = (id: string, api: string) =>
  ({ id, api, provider: 'p', baseUrl: 'https://p.invalid' }) as Model<Api>

test('the served api is the bearer api most models use, completions on a tie, none without one', () => {
  expect(
    bearerApi([
      model('a', 'openai-responses'),
      model('b', 'openai-responses'),
      model('c', 'openai-completions'),
      model('d', 'anthropic-messages'),
      model('e', 'anthropic-messages'),
      model('f', 'anthropic-messages'),
    ]),
  ).toBe('openai-responses')
  expect(
    bearerApi([
      model('a', 'openai-responses'),
      model('b', 'openai-completions'),
    ]),
  ).toBe('openai-completions')
  expect(bearerApi([model('a', 'anthropic-messages')])).toBeUndefined()
})

test('the owned form keeps only models of the served api, without their provider', () => {
  const owned = ownedModels(
    [
      model('a', 'openai-completions'),
      model('b', 'anthropic-messages'),
      model('c', 'openai-completions'),
    ],
    'openai-completions',
  )
  expect(owned.map((entry) => entry.id)).toEqual(['a', 'c'])
  expect(owned.every((entry) => !('provider' in entry))).toBe(true)
  expect(owned[0]).toMatchObject({ baseUrl: 'https://p.invalid' })
})

test('flags persist across a reload, and a damaged file grants neither consent nor release', async () => {
  const dir = path.join(await scratch('flags'), 'state')
  await mkdir(dir)
  const store = new FlagStore(dir)
  await store.set('fixture-a', { consented: true, released: true })
  const reloaded = new FlagStore(dir)
  await reloaded.load()
  expect(reloaded.get('fixture-a')).toEqual({
    consented: true,
    released: true,
  })
  expect(reloaded.get('fixture-b')).toEqual({
    consented: false,
    released: false,
  })
  await writeFile(path.join(dir, 'pi-activation.json'), '{"version":1,')
  const damaged = new FlagStore(dir)
  await damaged.load()
  expect(damaged.get('fixture-a')).toEqual({
    consented: false,
    released: false,
  })
})

test('flags never create the state folder, which setup creates owner-only', async () => {
  const dir = path.join(await scratch('flags'), 'missing')
  const store = new FlagStore(dir)
  await store.set('fixture-a', { consented: false, released: true })
  expect(existsSync(dir)).toBe(false)
  expect(store.get('fixture-a').released).toBe(true)
  await mkdir(dir)
  await store.set('fixture-a', { consented: false, released: true })
  expect(
    JSON.parse(await readFile(path.join(dir, 'pi-activation.json'), 'utf8')),
  ).toEqual({
    version: 1,
    providers: { 'fixture-a': { consented: false, released: true } },
  })
  await rm(dir, { recursive: true })
})

test('loading the extension registers /claustrum and session hooks and touches nothing else', () => {
  const calls: string[] = []
  const pi = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (...args: unknown[]) =>
          calls.push(`${String(key)}:${String(args[0])}`),
    },
  ) as ExtensionAPI
  extension(pi)
  expect(calls.sort()).toEqual([
    'on:session_shutdown',
    'on:session_start',
    'registerCommand:claustrum',
  ])
})
