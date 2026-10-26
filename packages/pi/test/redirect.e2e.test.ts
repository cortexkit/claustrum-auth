// Section 14.3 of the design: the HTTP redirect proof on the real Pi CLI.
// The plugin follows no cross-origin redirect, so the second origin must see
// no request at all, while the same-origin and no-redirect controls in the
// same run do deliver the vault key, so a zero there is real.
import { describe, expect, test } from 'bun:test'
import { e2e, row, secretOf } from './harness.ts'
import { redirectCodes, world } from './scenario.ts'

describe.skipIf(!e2e)('HTTP redirect proof on the real host', () => {
  test('a cross-origin 301, 302, 303, 307 or 308 never carries the vault key to the second origin', async () => {
    const { mock, launch } = await world({ rows: [row('a1', 'fixture-a')] })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    const bearer = `Bearer ${secretOf('a1')}`

    // Control: no redirect delivers the key to the provider's own origin.
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(mock.seen.at(-1)?.headers.authorization).toBe(bearer)

    for (const code of redirectCodes) {
      const before = mock.seen.length
      // Control: a same-origin redirect is followed with the key.
      expect(await pi.turn('fixture-a', `same-${code}`)).toMatchObject({
        text: 'served-ok',
      })
      const followed = mock.seen.slice(before)
      expect(followed.map((request) => request.path)).toEqual([
        `/same/${code}/v1/chat/completions`,
        '/ok/v1/chat/completions',
      ])
      expect(followed.map((request) => request.headers.authorization)).toEqual([
        bearer,
        bearer,
      ])

      const result = await pi.turn('fixture-a', `redirect-${code}`)
      expect(mock.seen.at(-1)?.path).toBe(
        `/redirect/${code}/v1/chat/completions`,
      )
      expect(result.text).toBe('')
      expect(result.error).not.toContain(secretOf('a1'))
    }
    expect(mock.second).toEqual([])
    expect(pi.output()).not.toContain(secretOf('a1'))
  })
})
