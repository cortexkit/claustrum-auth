import { expect, test } from 'bun:test'
import { createFetch, servingCallbacks } from '../src/index.ts'
import { fixtureEntries } from '../test-entry.ts'
import { bearer, harness, placeholder, row } from './fakes.ts'
import {
  fakeFirstRosterClock,
  gateFirstDiscovery,
} from './first-roster-fixture.ts'

for (const kind of ['fetch', 'callback'] as const) {
  test(`cold ${kind} requests join one first discovery before selecting routes`, async () => {
    const h = await harness(
      [row('a')],
      'opencode1',
      undefined,
      [fixtureEntries[0]],
      { refresh: false },
    )
    const clock = fakeFirstRosterClock()
    const gate = await gateFirstDiscovery(h)
    const options = {
      entry: fixtureEntries[0],
      placeholder,
      consumer: h.consumer,
    }
    const fetch = createFetch({
      ...options,
      fetch: async () => new Response('ok'),
    })
    const request = () =>
      kind === 'fetch'
        ? fetch('https://fixture.invalid', { headers: bearer })
        : servingCallbacks(options).request(
            new URL('https://fixture.invalid'),
            new Headers(bearer),
          )
    const pending = [request(), request()].map((work) =>
      work.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    )
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(clock.pending()).toBe(2)
      expect(h.reads).toEqual([])
      gate.release()
      const results = await Promise.all(pending)
      for (const result of results) {
        expect('error' in result).toBe(false)
        if (!('value' in result)) continue
        if (result.value instanceof Response)
          expect(await result.value.text()).toBe('ok')
        else expect(result.value?.receipt.accessToken).toBe('secret-a-1')
      }
      expect(h.stats().lists).toBe(1)
      expect(h.reads).toHaveLength(2)
      expect(clock.pending()).toBe(0)
    } finally {
      gate.release()
      await gate.discovery
      await Promise.all(pending)
    }
  })
}

test('a committed empty roster refuses without another discovery', async () => {
  const h = await harness([])
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  await expect(
    fetch('https://fixture.invalid', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'no-vault-account' })
  expect(h.stats().lists).toBe(1)
  expect(h.reads).toEqual([])
})
