// Pi slot handling on the real host: concurrent entry from two processes,
// crash recovery, the stash's Windows durability, and byte-for-byte release.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openPiSlot } from '@cortexkit/common-auth/pi-slot'
import {
  e2e,
  placeholderOf,
  readAuth,
  row,
  secretOf,
  until,
} from './harness.ts'
import {
  fillers,
  userAuthText,
  userLogins,
  waitForPlaceholder,
  world,
} from './scenario.ts'

const stashOf = (state: string, providerId: string) =>
  path.join(state, 'pi-slots', `${providerId}.json`)

// Each case starts one or two real Pi processes.
setDefaultTimeout(90_000)

describe.skipIf(!e2e)('Pi slots on the real host', () => {
  test('ten providers entered concurrently by two Pi processes keep auth.json consistent, and release restores it byte for byte', async () => {
    const ten = ['fixture-a', ...fillers]
    const logins: Record<string, unknown> = {
      openai: { type: 'api_key', key: 'user-openai-key' },
      ...userLogins,
    }
    // One provider starts with no login at all; release must remove its entry.
    delete logins['fixture-n9']
    const original = userAuthText(logins)
    const { agent, launch } = await world({
      rows: ten.map((id, index) => row(`r${index}`, id)),
      authText: original,
      flags: Object.fromEntries(ten.map((id) => [id, { consented: true }])),
    })
    const [first, second] = await Promise.all([launch(), launch()])
    for (const id of ten) await waitForPlaceholder(agent.authPath, id)
    // Both processes enter on their own first discovery; a status waits for
    // that process's queued slot work to finish.
    for (const pi of [first, second])
      await until(async () => {
        const status = await pi.slash('/claustrum')
        return ten.every((id) => status.includes(`${id}: owned`))
      })
    const auth = await readAuth(agent.authPath)
    for (const id of ten) {
      expect(auth[id]).toEqual({ type: 'api_key', key: placeholderOf(id) })
      expect(existsSync(stashOf(agent.state, id))).toBe(true)
    }
    expect(auth.openai).toEqual({ type: 'api_key', key: 'user-openai-key' })
    expect(auth['fixture-c']).toEqual(userLogins['fixture-c'])
    await second.stop()
    for (const id of ten)
      expect(await first.slash(`/claustrum release ${id}`)).toContain(
        `${id} is released`,
      )
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
    for (const id of ten)
      expect(existsSync(stashOf(agent.state, id))).toBe(false)
  })

  test('a crash between stash and placeholder: restart treats the provider as owned, completes the swap, and release restores the bytes', async () => {
    const original = userAuthText()
    const { agent, mock, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: original,
      flags: { 'fixture-a': { consented: true } },
    })
    const slot = openPiSlot({
      authPath: agent.authPath,
      provider: 'fixture-a',
      stashPath: stashOf(agent.state, 'fixture-a'),
      placeholderKey: placeholderOf('fixture-a'),
    })
    // pi-slot renames its stash before it renames auth.json; putting the
    // original auth.json back leaves exactly the state of a crash in between.
    await slot.enterVault()
    await writeFile(agent.authPath, original)
    expect(await slot.inspect()).toEqual({ slot: 'original', stash: 'valid' })
    const pi = await launch()
    await waitForPlaceholder(agent.authPath, 'fixture-a')
    expect(await pi.slash('/claustrum')).toContain('fixture-a: owned')
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(mock.seen[0]?.headers.authorization).toBe(`Bearer ${secretOf('a1')}`)
    if (process.platform !== 'win32') {
      // Windows protects these with owner-only access control lists instead
      // of file modes.
      expect(statSync(path.join(agent.state, 'pi-slots')).mode & 0o777).toBe(
        0o700,
      )
      expect(statSync(stashOf(agent.state, 'fixture-a')).mode & 0o777).toBe(
        0o600,
      )
      expect(
        statSync(path.join(agent.state, 'pi-activation.json')).mode & 0o777,
      ).toBe(0o600)
    }
    await pi.slash('/claustrum release fixture-a')
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
  })

  test('a crash after release was saved finishes the restore at restart', async () => {
    const original = userAuthText()
    const { agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: original,
      flags: { 'fixture-a': { consented: true, released: true } },
    })
    const slot = openPiSlot({
      authPath: agent.authPath,
      provider: 'fixture-a',
      stashPath: stashOf(agent.state, 'fixture-a'),
      placeholderKey: placeholderOf('fixture-a'),
    })
    await slot.enterVault()
    const pi = await launch()
    expect(await pi.slash('/claustrum')).toMatch(
      /fixture-a: available, \d vault account\(s\), released/u,
    )
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
    expect(existsSync(stashOf(agent.state, 'fixture-a'))).toBe(false)
  })

  test("a placeholder whose stash was lost, as Windows' file-only durability allows, stays owned and release leaves auth.json untouched", async () => {
    const text = userAuthText({
      ...userLogins,
      'fixture-a': { type: 'api_key', key: placeholderOf('fixture-a') },
    })
    const { agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: text,
    })
    const pi = await launch()
    expect(await pi.slash('/claustrum')).toContain('fixture-a: owned')
    expect(await pi.slash('/claustrum release fixture-a')).toContain(
      'The saved copy of your fixture-a login is missing',
    )
    expect(await readFile(agent.authPath, 'utf8')).toBe(text)
    expect(await pi.slash('/claustrum')).toContain('fixture-a: owned')
  })
})
