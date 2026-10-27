// Section 14.2 of the design on the real Pi CLI, with the fixture providers.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  anyFileContains,
  e2e,
  placeholderOf,
  row,
  secretOf,
  unenroll,
  until,
} from './harness.ts'
import { slotKey, userAuthText, waitForPlaceholder, world } from './scenario.ts'

const bearerOf = (id: string, version = 1) => `Bearer ${secretOf(id, version)}`
const authorizations = (requests: { headers: Record<string, unknown> }[]) =>
  requests.map((request) => request.headers.authorization)

// Each case starts one or two real Pi processes.
setDefaultTimeout(90_000)

describe.skipIf(!e2e)('Pi extension on the real host', () => {
  test('class A owned: only the vault key reaches the wire, and release restores the login byte for byte', async () => {
    const original = userAuthText()
    const { mock, vault, agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: original,
    })
    const pi = await launch()
    expect(await pi.slash('/claustrum use fixture-a')).toContain(
      'fixture-a now uses keys from the Claustrum vault',
    )
    // Consent is asked before the login moves, and names what happens.
    expect(pi.confirms).toHaveLength(1)
    expect(pi.confirms[0]?.message).toContain('moved aside')
    expect(await slotKey(agent.authPath, 'fixture-a')).toBe(
      placeholderOf('fixture-a'),
    )
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
      error: '',
    })
    expect(authorizations(mock.seen)).toEqual([bearerOf('a1')])
    expect(JSON.stringify(mock.seen)).not.toContain(placeholderOf('fixture-a'))
    expect(vault.reads).toEqual(['a1'])
    expect(await pi.slash('/claustrum release fixture-a')).toContain(
      'your own Pi login is back',
    )
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(authorizations(mock.seen).at(-1)).toBe('Bearer user-key-fixture-a')
    expect(vault.reads).toEqual(['a1'])
  })

  test("a user's own key on a served provider is sent unchanged with no vault read or report", async () => {
    const { mock, vault, launch } = await world({
      rows: [row('a1', 'fixture-a')],
    })
    const pi = await launch()
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(authorizations(mock.seen)).toEqual(['Bearer user-key-fixture-a'])
    expect(vault.reads).toEqual([])
    expect(vault.reports).toEqual([])
  })

  test('vault mode switched off exits the slot and restores the original login', async () => {
    const original = userAuthText()
    const { agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: original,
      flags: { 'fixture-a': { consented: true } },
    })
    const pi = await launch()
    // Consented and not released: entered automatically once rows route.
    await waitForPlaceholder(agent.authPath, 'fixture-a')
    await unenroll(agent.agent)
    await until(
      async () => (await readFile(agent.authPath, 'utf8')) === original,
    )
    expect(await pi.slash('/claustrum')).toContain('fixture-a: available')
    expect(anyFileContains(agent.home, secretOf('a1'))).toEqual([])
  })

  test('two accounts: a 429 before output moves to the second account and marks the first', async () => {
    const { mock, vault, launch } = await world({
      rows: [row('a1', 'fixture-a'), row('a2', 'fixture-a')],
    })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    expect(await pi.turn('fixture-a', 'first429')).toMatchObject({
      text: 'served-ok',
      error: '',
    })
    expect(authorizations(mock.seen)).toEqual([bearerOf('a1'), bearerOf('a2')])
    // The mark holds: the next turn goes straight to the second account.
    expect(await pi.turn('fixture-a', 'first429')).toMatchObject({
      text: 'served-ok',
    })
    expect(authorizations(mock.seen)).toEqual([
      bearerOf('a1'),
      bearerOf('a2'),
      bearerOf('a2'),
    ])
    expect(vault.reports).toEqual([])
  })

  test('exhaustion shows the provider final 429 and final 401, read from bodies the plugin did not cancel', async () => {
    const limited = await world({
      rows: [row('a1', 'fixture-a'), row('a2', 'fixture-a')],
    })
    const first = await limited.launch()
    await first.slash('/claustrum use fixture-a')
    const all429 = await first.turn('fixture-a', 'all429')
    expect(all429.error).toContain('provider limit 2')
    expect(authorizations(limited.mock.seen)).toEqual([
      bearerOf('a1'),
      bearerOf('a2'),
    ])
    const rejected = await world({
      rows: [row('a1', 'fixture-a'), row('a2', 'fixture-a')],
    })
    const second = await rejected.launch()
    await second.slash('/claustrum use fixture-a')
    const all401 = await second.turn('fixture-a', 'all401')
    expect(all401.error).toContain('provider rejected key 2')
    expect(authorizations(rejected.mock.seen)).toEqual([
      bearerOf('a1'),
      bearerOf('a2'),
    ])
  })

  test('401: one report with the served record version, none for a kept receipt, none for rows the plugin does not serve', async () => {
    const { vault, launch } = await world({
      rows: [
        row('a1', 'fixture-a', { recordVersion: 1 }),
        row('openai-key', 'openai'),
        row('chatgpt', 'fixture-a', { authMethod: 'chatgpt' }),
      ],
    })
    vault.version = 7
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    // A first read keeps a receipt; with reads down that kept receipt serves.
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    vault.readsDown = true
    expect((await pi.turn('fixture-a', 'all401')).error).toContain(
      'provider rejected key',
    )
    expect(vault.reports).toEqual([])
    vault.readsDown = false
    expect((await pi.turn('fixture-a', 'all401')).error).toContain(
      'provider rejected key',
    )
    expect(vault.reports).toEqual([{ credentialId: 'a1', recordVersion: 7 }])
    expect(vault.reads).not.toContain('openai-key')
    expect(vault.reads).not.toContain('chatgpt')
  })

  test('vault unreachable: with no earlier read the request is refused; after one read the kept key serves', async () => {
    const { mock, vault, launch } = await world({
      rows: [row('a1', 'fixture-a')],
    })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    vault.readsDown = true
    const refused = await pi.turn('fixture-a', 'ok')
    expect(refused.error).toContain('the Claustrum vault could not be reached')
    expect(mock.seen).toEqual([])
    vault.readsDown = false
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    vault.readsDown = true
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
    expect(authorizations(mock.seen)).toEqual([bearerOf('a1'), bearerOf('a1')])
    expect(vault.reads).toEqual(['a1'])
  })

  test('a base URL overridden to another origin is refused locally: neither origin sees the key and the vault is not read', async () => {
    const { mock, vault, launch } = await world({
      rows: [row('a1', 'fixture-a')],
    })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    const result = await pi.turn('fixture-a', 'elsewhere')
    expect(result.error).toContain(
      `the vault key for fixture-a is only sent to ${mock.origin}`,
    )
    expect(mock.seen).toEqual([])
    expect(mock.second).toEqual([])
    expect(vault.reads).toEqual([])
  })

  test('a key echoed in an error body, an SSE error event or a reset connection never reaches Pi output or files', async () => {
    const { agent, mock, launch } = await world({
      rows: [row('a1', 'fixture-a')],
    })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    const echo = await pi.turn('fixture-a', 'echo')
    const sse = await pi.turn('fixture-a', 'echosse')
    const reset = await pi.turn('fixture-a', 'reset')
    // Each case did reach the provider with the key and produced an error.
    expect(authorizations(mock.seen)).toEqual([
      bearerOf('a1'),
      bearerOf('a1'),
      bearerOf('a1'),
    ])
    expect(echo.error).toContain('bad key')
    expect(sse.error).toContain('bad key')
    expect(reset.error).not.toBe('')
    for (const result of [echo, sse, reset])
      expect(result.error).not.toContain(secretOf('a1'))
    expect(pi.output()).not.toContain(secretOf('a1'))
    expect(anyFileContains(agent.home, secretOf('a1'))).toEqual([])
  })

  test('fixture-p: a placeholder in Authorization and x-api-key is refused locally with no send and no vault read', async () => {
    const { mock, vault, launch } = await world({
      rows: [row('p1', 'fixture-p')],
    })
    const pi = await launch()
    expect(await pi.slash('/claustrum use fixture-p')).toContain(
      'fixture-p now uses keys',
    )
    const result = await pi.turn('fixture-p', 'p1')
    expect(result.error).toContain('outside the Authorization header')
    expect(mock.seen).toEqual([])
    expect(vault.reads).toEqual([])
  })

  test('fixture-c owned hides its anthropic-messages model, and release offers it again', async () => {
    const { launch } = await world({ rows: [row('c1', 'fixture-c')] })
    const pi = await launch()
    const before = await pi.models()
    expect(before).toContain('fixture-c/c-chat')
    expect(before).toContain('fixture-c/c-messages')
    await pi.slash('/claustrum use fixture-c')
    expect(pi.confirms[0]?.message).toContain('1 fixture-c model')
    const owned = await pi.models()
    expect(owned).toContain('fixture-c/c-chat')
    expect(owned).not.toContain('fixture-c/c-messages')
    expect(await pi.slash('/claustrum')).toContain('1 model(s) hidden')
    await pi.slash('/claustrum release fixture-c')
    expect(await pi.models()).toEqual(before)
  })

  test("class B: the path carries the served receipt's account, and a receipt without one is refused after its one read", async () => {
    const { mock, vault, launch } = await world({
      rows: [row('b1', 'fixture-b', { accountId: undefined })],
    })
    vault.servedAccounts.set('b1', 'served-acct')
    const pi = await launch()
    await pi.slash('/claustrum use fixture-b')
    expect(await pi.turn('fixture-b', 'b1')).toMatchObject({
      text: 'served-ok',
    })
    expect(mock.seen.map((request) => request.path)).toEqual([
      '/client/v4/accounts/served-acct/v1/chat/completions',
    ])
    vault.servedAccounts.set('b1', null)
    const refused = await pi.turn('fixture-b', 'b1')
    expect(refused.error).toContain('names no account')
    expect(mock.seen).toHaveLength(1)
    expect(vault.reads).toEqual(['b1', 'b1'])
  })

  test('a reserved provider with a vault row is never registered, and only listed fixtures are', async () => {
    const { vault, agent, launch } = await world({
      rows: [row('openai-key', 'openai'), row('a1', 'fixture-a')],
    })
    const registrations = `${agent.home}-registrations.jsonl`
    await Bun.write(registrations, '')
    const pi = await launch({ config: { registrations } })
    await pi.slash('/claustrum use fixture-a')
    const names = (await Bun.file(registrations).text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).name as string)
    expect(names).not.toContain('openai')
    expect(new Set(names)).toEqual(
      new Set([
        'fixture-a',
        'fixture-b',
        'fixture-c',
        'fixture-p',
        ...Array.from({ length: 9 }, (_, index) => `fixture-n${index + 1}`),
      ]),
    )
    expect(vault.reads).not.toContain('openai-key')
  })

  test('vault down at start: providers are registered, and activation works once the vault answers', async () => {
    const { vault, launch } = await world({ rows: [row('a1', 'fixture-a')] })
    vault.down = true
    const pi = await launch()
    expect(await pi.models()).toContain('fixture-a/ok')
    expect(await pi.slash('/claustrum use fixture-a')).toContain(
      'serves no usable account for fixture-a',
    )
    vault.down = false
    expect(await pi.slash('/claustrum use fixture-a')).toContain(
      'fixture-a now uses keys',
    )
    expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
      text: 'served-ok',
    })
  })

  test('release, then restart: the provider stays released', async () => {
    const original = userAuthText()
    const { agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
      authText: original,
      flags: { 'fixture-a': { consented: true } },
    })
    const first = await launch()
    await waitForPlaceholder(agent.authPath, 'fixture-a')
    await first.slash('/claustrum release fixture-a')
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
    await first.stop()
    const second = await launch()
    // Discovery finds the row routable, which would enter a consented,
    // unreleased provider; give the sync loop several rounds to act on it.
    await until(async () =>
      (await second.slash('/claustrum')).includes(
        'fixture-a: available, 1 vault account(s), released',
      ),
    )
    await Bun.sleep(500)
    expect(await second.slash('/claustrum')).toContain(
      'fixture-a: available, 1 vault account(s), released',
    )
    expect(await readFile(agent.authPath, 'utf8')).toBe(original)
  })

  test('rows vanish while owned: requests refuse locally, nothing is sent and the slot is kept', async () => {
    const { mock, vault, agent, launch } = await world({
      rows: [row('a1', 'fixture-a')],
    })
    const pi = await launch()
    await pi.slash('/claustrum use fixture-a')
    vault.rows = []
    await until(async () =>
      (await pi.slash('/claustrum')).includes('fixture-a: owned, 0 vault'),
    )
    const result = await pi.turn('fixture-a', 'ok')
    expect(result.error).toContain('has no usable account for fixture-a')
    expect(mock.seen).toEqual([])
    expect(await slotKey(agent.authPath, 'fixture-a')).toBe(
      placeholderOf('fixture-a'),
    )
  })

  test('the published bundle loads in Pi with no fixture provider', async () => {
    const { launch } = await world({ rows: [row('a1', 'fixture-a')] })
    const pi = await launch({ production: true })
    const status = await pi.slash('/claustrum')
    expect(status).toContain('claustrum-auth: vault mode on')
    expect(status).not.toContain('fixture')
    expect(await pi.slash('/claustrum use fixture-a')).toContain(
      'does not serve "fixture-a"',
    )
  })
})
