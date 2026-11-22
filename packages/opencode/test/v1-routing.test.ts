import { expect, test } from 'bun:test'
import { harness, row } from '../../core/test/fakes.ts'
import { capacityRouting, routing } from '../../core/test/routing-fixtures.ts'
import { fixtureEntries } from '../../core/test-entry.ts'
import { providerFetch } from '../src/v1/fetch.ts'
import { placeholderFor } from '../src/v1/placeholder.ts'

async function world() {
  const h = await harness([row('a'), row('b')])
  const sent: Request[] = []
  const serve = providerFetch({
    provider: 'fixture-a',
    entry: fixtureEntries[0],
    consumer: h.consumer,
    envNames: async () => [],
    env: () => ({}),
    transport: async (input, init) => {
      sent.push(new Request(input, init))
      return new Response('{"ok":true}')
    },
  })
  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${placeholderFor('fixture-a')}`,
      'session-id': 'host-session',
    },
    body: '{"model":"requested-model"}',
  }
  return { h, sent, serve, init }
}

test('routing OC1 uses stamped session and routing key, strips private header, fails closed without session', async () => {
  const { sent, serve, init } = await world()
  const { calls, reports } = routing(async () => ({ account_id: 'account-b' }))
  const response = await serve('https://fixture.invalid', init)
  expect(await response.json()).toEqual({ ok: true })
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'b',
      outcome: 'served',
      headers: {},
    },
  ])
  expect(sent.map((r) => r.headers.get('authorization'))).toEqual([
    'Bearer secret-b-1',
  ])
  expect(sent[0]?.headers.has('session-id')).toBe(false)
  expect(calls).toEqual([
    {
      session: 'host-session',
      request: {
        provider: 'fixture-a',
        modelId: 'requested-model',
        refusals: true,
        waits_for_capacity: true,
        request_id: expect.any(String),
        candidates: {
          accounts: [
            { account_id: 'account-a', credential_id: 'a' },
            { account_id: 'account-b', credential_id: 'b' },
          ],
          view_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
      options: { deadlineMs: 1500 },
    },
  ])
  await expect(
    serve('https://fixture.invalid', {
      ...init,
      headers: { authorization: init.headers.authorization },
    }),
  ).rejects.toThrow(
    'Thalamus routing did not answer, so this API key request was not sent.',
  )
  expect(sent).toHaveLength(1)
})

test('routing OC1 waits for capacity and re-asks for the same attempt', async () => {
  const { sent, serve, init } = await world()
  const { calls, timing } = capacityRouting('account-b')
  const response = await serve('https://fixture.invalid', init)
  expect(response.ok).toBe(true)
  expect(sent.map((r) => r.headers.get('authorization'))).toEqual([
    'Bearer secret-b-1',
  ])
  expect(calls.map(({ request }) => request.request_id)).toEqual([
    expect.any(String),
    calls[0]?.request.request_id,
  ])
  expect(timing.askedAgainAtMs).toBeGreaterThanOrEqual(timing.resetsAtMs)
})

test('routing OC1 abort stops the capacity wait without re-asking or sending', async () => {
  const { h, sent, serve, init } = await world()
  const controller = new AbortController()
  const reason = new Error('turn cancelled')
  const { calls } = capacityRouting('account-b', () => controller.abort(reason))
  await expect(
    serve('https://fixture.invalid', { ...init, signal: controller.signal }),
  ).rejects.toThrow('turn cancelled')
  expect(calls).toHaveLength(1)
  expect(h.reads).toEqual([])
  expect(sent).toEqual([])
})
