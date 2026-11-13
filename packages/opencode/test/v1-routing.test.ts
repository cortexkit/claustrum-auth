import { expect, test } from 'bun:test'
import { harness, row } from '../../core/test/fakes.ts'
import { routing } from '../../core/test/routing-fixtures.ts'
import { fixtureEntries } from '../../core/test-entry.ts'
import { providerFetch } from '../src/v1/fetch.ts'
import { placeholderFor } from '../src/v1/placeholder.ts'

test('routing OC1 uses stamped session and routing key, strips private header, fails closed without session', async () => {
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
  const { calls, reports } = routing(async () => ({ account_id: 'account-b' }))
  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${placeholderFor('fixture-a')}`,
      'session-id': 'host-session',
    },
    body: '{"model":"requested-model"}',
  }
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
