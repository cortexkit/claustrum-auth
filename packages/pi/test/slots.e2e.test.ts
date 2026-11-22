// Pi slot handling on the real host: concurrent entry, legacy stash cleanup,
// release recovery, and preservation of a replacement login.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { openPiSlot } from '@cortexkit/common-auth/pi-slot'
import { createOwnerOnly } from '@cortexkit/private-files'
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
  test('ten providers entered concurrently by two Pi processes keep auth.json consistent, and release clears just their placeholders', async () => {
    const ten = ['fixture-a', ...fillers]
    const logins: Awaited<ReturnType<typeof readAuth>> = {
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
      expect(existsSync(stashOf(agent.state, id))).toBe(false)
    }
    expect(auth.openai).toEqual({ type: 'api_key', key: 'user-openai-key' })
    expect(auth['fixture-c']).toEqual(userLogins['fixture-c'])
    await second.stop()
    for (const id of ten)
      expect(await first.slash(`/claustrum release ${id}`)).toContain(
        `${id} is released`,
      )
    expect(await readAuth(agent.authPath)).toEqual(
      Object.fromEntries(
        Object.entries(logins).filter(([id]) => !ten.includes(id)),
      ),
    )
  })

  test('a legacy stash is discarded on connect after discovery, never used to take over before discovery or restored', async () => {
    const { agent, vault, mock, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      flags: { 'fixture-a': { consented: true } },
    })
    // It need not be a valid stash: legacy credentials must not be parsed.
    const stash = stashOf(agent.state, 'fixture-a')
    await createOwnerOnly(path.dirname(stash), { kind: 'dir' })
    await writeJsonAtomic(stash, { retired: 'legacy fixture' })
    vault.down = true
    const pi = await launch()
    expect(await pi.slash('/claustrum')).toContain('fixture-a: available')
    expect((await readAuth(agent.authPath))['fixture-a']).toEqual(
      userLogins['fixture-a'],
    )
    vault.down = false
    await waitForPlaceholder(agent.authPath, 'fixture-a')
    expect(await pi.slash('/claustrum')).toContain('fixture-a: owned')
    expect(existsSync(stash)).toBe(false)
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(mock.seen[0]?.headers.authorization).toBe(`Bearer ${secretOf('a1')}`)
    await pi.slash('/claustrum release fixture-a')
    expect((await readAuth(agent.authPath))['fixture-a']).toBeUndefined()
  })

  test('a crash after release was saved clears the placeholder at restart', async () => {
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
    expect((await readAuth(agent.authPath))['fixture-a']).toBeUndefined()
    expect(existsSync(stashOf(agent.state, 'fixture-a'))).toBe(false)
  })

  test('a placeholder without a stash is owned and can be released', async () => {
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
      'Sign in to fixture-a again in Pi',
    )
    expect((await readAuth(agent.authPath))['fixture-a']).toBeUndefined()
    expect(await pi.slash('/claustrum')).toContain('fixture-a: available')
  })

  test('release never overwrites a login added while the vault owned the slot', async () => {
    const { agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      auth: {
        'fixture-a': { type: 'api_key', key: placeholderOf('fixture-a') },
      },
    })
    const pi = await launch()
    expect(await pi.slash('/claustrum')).toContain('fixture-a: owned')
    const updated = userAuthText({
      'fixture-a': { type: 'api_key', key: 'replacement-user-key' },
    })
    await writeFile(agent.authPath, updated)
    expect(await pi.slash('/claustrum release fixture-a')).toContain(
      'Sign in with Pi again if needed',
    )
    expect(await readFile(agent.authPath, 'utf8')).toBe(updated)
    expect(await pi.slash('/claustrum')).toContain('fixture-a: available')
  })
})
