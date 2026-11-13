import { expect, test } from 'bun:test'
import { harness, row } from '../../core/test/fakes.ts'
import {
  fakeFirstRosterClock,
  gateFirstDiscovery,
} from '../../core/test/first-roster-fixture.ts'
import { fixtureEntries } from '../../core/test-entry.ts'
import { providerFetch } from '../src/v1/fetch.ts'
import { placeholderFor } from '../src/v1/placeholder.ts'

const provider = 'fixture-a'
const url = 'https://fixture.invalid/v1/chat/completions'

function request(signal?: AbortSignal) {
  return new Request(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${placeholderFor(provider)}` },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed body'))
        controller.close()
      },
    }),
    signal,
    duplex: 'half',
  } as RequestInit)
}

for (const outcome of ['landed', 'deadline', 'aborted'] as const) {
  test(`a cold OpenCode 1 streamed Request joins first discovery (${outcome})`, async () => {
    const h = await harness(
      [row('a')],
      'opencode1',
      undefined,
      fixtureEntries,
      { refresh: false },
    )
    const clock = fakeFirstRosterClock()
    const gate = await gateFirstDiscovery(h)
    const controller = new AbortController()
    let sends = 0
    let rediscoveries = 0
    const fetch = providerFetch({
      provider,
      entry: fixtureEntries[0],
      consumer: h.consumer,
      limits: () => h.limits(provider),
      envNames: async () => [],
      env: () => ({}),
      discover: async () => {
        rediscoveries++
        await h.hub.refresh()
        return 'listed'
      },
      transport: async (input) => {
        sends++
        const sent = input as Request
        expect(sent.headers.get('authorization')).toBe('Bearer secret-a-1')
        expect(await sent.text()).toBe('streamed body')
        return new Response('ok')
      },
    })
    let settled = false
    const response = fetch(request(controller.signal))
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true
      })
    try {
      // Flush request continuations without advancing the injected deadline.
      await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(clock.pending()).toBe(1)
      expect(h.stats().lists).toBe(0)
      if (outcome === 'landed') gate.release()
      if (outcome === 'deadline') {
        clock.advance(1_999)
        await Promise.resolve()
        expect(settled).toBe(false)
        clock.advance(1)
      }
      if (outcome === 'aborted') controller.abort()
      const result = await response
      if (outcome === 'landed') {
        expect('value' in result && (await result.value.text())).toBe('ok')
        expect(sends).toBe(1)
        expect(h.stats().lists).toBe(1)
      } else {
        expect('error' in result && result.error).toMatchObject(
          outcome === 'deadline'
            ? {
                name: 'ClaustrumRefusal',
                code: 'no-vault-account',
                message: 'claustrum-auth: no vault account for fixture-a.',
              }
            : { name: 'AbortError' },
        )
        expect(sends).toBe(0)
        expect(h.reads).toEqual([])
      }
      expect(rediscoveries).toBe(0)
      expect(clock.pending()).toBe(0)
    } finally {
      gate.release()
      await gate.discovery
      await response
    }
  })
}

test('a warm empty OpenCode 1 roster still discovers an account added after startup', async () => {
  const rows: ReturnType<typeof row>[] = []
  const h = await harness(rows)
  let discoveries = 0
  let sends = 0
  const fetch = providerFetch({
    provider,
    entry: fixtureEntries[0],
    consumer: h.consumer,
    envNames: async () => [],
    env: () => ({}),
    discover: async () => {
      discoveries++
      rows.push(row('new'))
      h.client.listScoped = async () => ({
        rows,
        view: 'view-2',
        grants: undefined,
        grantTuples: undefined,
      })
      await h.hub.refresh()
      return 'listed'
    },
    transport: async (input) => {
      sends++
      expect((input as Request).headers.get('authorization')).toBe(
        'Bearer secret-new-1',
      )
      return new Response('ok')
    },
  })
  const result = await fetch(url, {
    headers: { authorization: `Bearer ${placeholderFor(provider)}` },
  })
  expect(await result.text()).toBe('ok')
  expect(discoveries).toBe(1)
  expect(sends).toBe(1)
})
