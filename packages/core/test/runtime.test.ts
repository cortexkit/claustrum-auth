import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { unsavedRosterCause } from '../src/runtime.ts'
import { createTestCore } from '../test-entry.ts'
import { row } from './fakes.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function core() {
  // As in fakes.ts: common-auth refuses a scratch folder other users may
  // change, which a Windows CI checkout is, so Windows uses the user's temp.
  const scratch =
    process.platform === 'win32'
      ? path.join(os.tmpdir(), 'claustrum-auth-scratch')
      : path.join(import.meta.dir, '..', '..', '..', 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'runtime-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const tokenPath = path.join(dir, 'token.json')
  await writeJsonAtomic(tokenPath, {
    token: '01'.repeat(32),
    token_generation: 1,
  })
  const client: ClaustrumScopedClient = {
    async listScoped() {
      return {
        rows: [row('a')],
        view: 'view-1',
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      throw new Error('no read')
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const built = createTestCore({
    stateDir: dir,
    tokenPath,
    connect: async () => client,
    facts: {
      host: 'opencode1',
      catalog: ['fixture-a', 'fixture-b'],
      integrations: { 'fixture-a': 'fixture-a', 'fixture-b': 'fixture-b' },
    },
  })
  cleanup.push(() => built.hub.dispose())
  return built
}

test('a member whose roster commit failed is named as unsaved, and a later commit clears it', async () => {
  const built = await core()
  // A folder at the member's roster path: the hub can neither read nor
  // replace that file, so this member's commit fails while the list succeeds.
  const target = built.hub.rosterPath('fixture-a')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  await built.hub.refresh()
  const member = built.consumers.get('fixture-a')
  expect(member?.snapshot()).toBeUndefined()
  // The other member committed the same list: it holds a list, empty here.
  expect(built.consumers.get('fixture-b')?.snapshot()?.rows).toEqual([])
  expect(await unsavedRosterCause(built, 'fixture-b')).toBeUndefined()
  const cause = await unsavedRosterCause(built, 'fixture-a')
  expect(cause).toBeString()
  expect(cause).not.toBe('its file was locked')
  await rm(target, { recursive: true })
  // One more refresh commits the member, so nothing is unsaved any more.
  expect(await unsavedRosterCause(built, 'fixture-a')).toBeUndefined()
  expect(member?.routingRows()).toHaveLength(1)
})
