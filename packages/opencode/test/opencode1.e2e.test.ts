import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { fixtureEntries } from '../../core/test-entry.ts'
import { resolveOpencodeStateDir } from '../src/state-dir.ts'
import { fixtureClient } from './e2e/fixture-plugin.ts'
import {
  enabled,
  fixtureProviders,
  type Host,
  hostBinary,
  type Mock,
  type Profile,
  placeholderOf,
  profile,
  type Recorded,
  realProfileStamp,
  sessionDump,
  slow,
  startHost,
  startMock,
  vaultRow,
} from './e2e/host.ts'
import { setupIO, setupTestBuild } from './setup-harness.ts'

const A = 'fixture-a'
const timeout = 300_000 * slow
const placeholderA = { type: 'api', key: placeholderOf(A) }

let mock: Mock
let second: Mock
const hosts: Host[] = []
let stamp = ''

async function host(p: Profile, env: Record<string, string> = {}) {
  const started = await startHost(p, env)
  hosts.push(started)
  return started
}
async function stopAll() {
  for (const started of hosts.splice(0)) await started.stop()
}

// Every request the mock saw for the turn, leaving out the host's own title
// request, which it sends on a session's first message.
function turns(target: Mock = mock): Recorded[] {
  return target.requests.filter((request) => !request.title)
}
function bearers(target: Mock = mock) {
  return target.requests.map((request) => request.headers.authorization)
}
function wire(target: Mock) {
  return JSON.stringify(target.requests)
}
async function gets(p: Profile) {
  return (await p.vaultLog()).filter((entry) => entry.op === 'get')
}
async function reports(p: Profile) {
  return (await p.vaultLog()).filter((entry) => entry.op === 'report')
}

describe.skipIf(!enabled)(`OpenCode 1 real host (${process.platform})`, () => {
  beforeAll(async () => {
    stamp = realProfileStamp()
    hostBinary()
    mock = await startMock()
    second = await startMock()
  }, 900_000)
  afterAll(async () => {
    await stopAll()
    await mock?.close()
    await second?.close()
    // Nothing was written under the real profile.
    if (enabled) expect(realProfileStamp()).toBe(stamp)
  })

  function reset() {
    mock.requests.length = 0
    second.requests.length = 0
    mock.reply = () => ({ kind: 'ok' })
    second.reply = () => ({ kind: 'ok' })
  }

  test.skipIf(process.env.CLAUSTRUM_AUTH_SETUP_E2E !== '1')(
    'setup test build enrolls a clean OpenCode 1 profile and its printed activation serves a fixture request',
    async () => {
      reset()
      const p = await profile(
        'setup',
        mock,
        {
          rows: [vaultRow('setup', A)],
          served: { setup: { material: 'setup-vault-key' } },
        },
        true,
      )
      const paths = hostEnrollmentPaths({
        stateDir: resolveOpencodeStateDir(p.env, p.env.HOME),
        host: 'opencode',
      })
      expect(existsSync(paths.tokenPath)).toBe(false)
      expect(existsSync(p.authFile)).toBe(false)
      const io = setupIO(p.root, p.env)
      await (await setupTestBuild())(
        ['--yes', '--claustrum', '--host=opencode', '--opencode=1'],
        io.io,
        fixtureEntries,
        async () => fixtureClient(p.control),
      )
      expect(io.proposals).toEqual(['claustrum-auth-opencode'])
      expect(await enrollmentAuthority(paths, 'claustrum-auth-opencode')).toBe(
        'vault',
      )
      expect((await p.auth())[A]).toBeUndefined()
      p.env.CLAUSTRUM_AUTH_E2E_SETUP = '1'
      let h = await host(p)
      const session = await h.session()
      const printed = io
        .output()
        .split('\n')
        .find((line) => line === '/claustrum use fixture-a')
      expect(printed).toBeDefined()
      expect(
        await h.command(
          session,
          (printed as string).slice('/claustrum '.length),
        ),
      ).toContain('now uses the vault')
      expect(await h.command(session, 'status')).toContain('Vault mode: on')
      expect(await h.command(session, 'accounts')).toContain('fixture-a')
      expect(await h.command(session, 'refusals')).toContain(
        'Refused vault rows:',
      )
      await stopAll()
      h = await host(p)
      expect((await h.turn(A)).error).toBeUndefined()
      expect(turns().map((request) => request.headers.authorization)).toEqual([
        'Bearer setup-vault-key',
      ])
      await stopAll()
    },
    timeout,
  )

  test(
    'class A owned: /claustrum use writes the placeholder, the next start serves the vault key, and the placeholder never reaches the wire',
    async () => {
      reset()
      const p = await profile('owned', mock, {
        rows: [
          vaultRow('a', A),
          vaultRow('openai', 'openai'),
          vaultRow('chatgpt', 'openai', { authMethod: 'chatgpt' }),
        ],
        served: { a: { material: 'vault-key-a' } },
      })
      let h = await host(p)
      const session = await h.session()
      const shown = await h.command(session, `use ${A}`)
      expect(shown).toContain('now uses the vault')
      expect(shown).toContain('next time OpenCode starts')
      expect((await p.auth())[A]).toEqual(placeholderA)
      await stopAll()
      h = await host(p)
      const result = await h.turn(A)
      expect(result.error).toBeUndefined()
      expect(result.text).toContain('hello from the mock')
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-a',
      ])
      expect(wire(mock)).not.toContain(placeholderOf(A))
      const read = await gets(p)
      expect(read.every((entry) => entry.credentialId === 'a')).toBe(true)
      expect(await reports(p)).toEqual([])
      await stopAll()
    },
    timeout,
  )

  test(
    'the redirect proof: no cross-origin 3xx delivers the key; same-origin and no redirect do',
    async () => {
      reset()
      const p = await profile('redirect', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-redirect' } },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p)
      for (const status of [301, 302, 303, 307, 308]) {
        mock.reply = () => ({
          kind: 'redirect',
          status,
          location: `${second.origin}/v1/chat/completions`,
        })
        const result = await h.turn(A)
        expect(result.error).toBeDefined()
      }
      expect(JSON.stringify(second.requests)).not.toContain(
        'vault-key-redirect',
      )
      expect(second.requests).toEqual([])
      // Controls in the same run: a same-origin redirect and no redirect both
      // deliver the key, so the zero above is real.
      mock.requests.length = 0
      mock.reply = (request) =>
        request.path.startsWith('/v1/moved')
          ? { kind: 'ok' }
          : {
              kind: 'redirect',
              status: 307,
              location: `${mock.origin}/v1/moved/chat/completions`,
            }
      expect((await h.turn(A)).error).toBeUndefined()
      const moved = turns().filter((r) => r.path.startsWith('/v1/moved'))
      expect(moved.map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-redirect',
      ])
      expect(moved[0]?.body).toContain('claustrum-e2e-turn')
      mock.requests.length = 0
      mock.reply = () => ({ kind: 'ok' })
      expect((await h.turn(A)).error).toBeUndefined()
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-redirect',
      ])
      await stopAll()
    },
    timeout,
  )

  test(
    'redaction: an echoed key in an error body, an SSE error event and a reset connection never reaches what the host shows or logs',
    async () => {
      reset()
      const secret = 'vault-key-echo-0123456789'
      const p = await profile('echo', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: secret } },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p)
      mock.reply = () => ({
        kind: 'status',
        status: 400,
        body: JSON.stringify({
          error: { message: `bad request echo ${secret}`, type: 'invalid' },
        }),
      })
      const body = await h.turn(A)
      expect(body.error).toContain('bad request echo')
      expect(body.error).not.toContain(secret)
      expect(await sessionDump(h, body.session)).not.toContain(secret)
      mock.reply = () => ({
        kind: 'sse-error',
        message: `stream echo ${secret}`,
      })
      const sse = await h.turn(A)
      expect(await sessionDump(h, sse.session)).toContain('stream echo')
      expect(await sessionDump(h, sse.session)).not.toContain(secret)
      mock.reply = () => ({ kind: 'reset' })
      const dropped = await h.retrying(A)
      expect(dropped.message).not.toContain(secret)
      expect(await sessionDump(h, dropped.session)).not.toContain(secret)
      // The key did reach the mock, so the absence above is not vacuous.
      expect(bearers()).toContain(`Bearer ${secret}`)
      await stopAll()
      expect(await h.logs()).not.toContain(secret)
      expect(h.output()).not.toContain(secret)
    },
    timeout,
  )

  test(
    'class C is refused locally and class B carries the served account',
    async () => {
      reset()
      const p = await profile('classes', mock, {
        rows: [
          vaultRow('b', 'fixture-b', { accountId: undefined }),
          vaultRow('c', 'fixture-c'),
        ],
        served: {
          b: { material: 'vault-key-b', accountId: 'served-account' },
          c: { material: 'vault-key-c' },
        },
      })
      await p.setAuth({
        'fixture-b': { type: 'api', key: placeholderOf('fixture-b') },
        'fixture-c': { type: 'api', key: placeholderOf('fixture-c') },
      })
      const h = await host(p)
      const c = await h.turn('fixture-c')
      expect(c.error).toContain('only serves keys sent in Authorization')
      expect(mock.requests).toEqual([])
      expect(await gets(p)).toEqual([])
      const b = await h.turn('fixture-b')
      expect(b.error).toBeUndefined()
      const served = turns()
      expect(served.map((r) => r.path)).toEqual([
        '/client/v4/accounts/served-account/ai/v1/chat/completions',
      ])
      expect(served[0]?.headers.authorization).toBe('Bearer vault-key-b')
      // A receipt with no account is refused after its one read.
      mock.requests.length = 0
      await p.vault({
        served: { b: { material: 'vault-key-b', accountId: null } },
      })
      const before = (await gets(p)).length
      const missing = await h.turn('fixture-b')
      expect(missing.error).toContain('served no account')
      expect(turns()).toEqual([])
      expect((await gets(p)).length).toBeGreaterThan(before)
      await stopAll()
    },
    timeout,
  )

  test(
    'a config baseURL to a second loopback origin is refused with no vault read',
    async () => {
      reset()
      const p = await profile('origin', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-origin' } },
      })
      await p.setAuth({ [A]: placeholderA })
      await p.config(fixtureProviders(mock.origin, second.origin))
      const h = await host(p)
      const result = await h.turn(A)
      expect(result.error).toContain('only sent to the provider')
      expect(mock.requests).toEqual([])
      expect(second.requests).toEqual([])
      expect(await gets(p)).toEqual([])
      await stopAll()
    },
    timeout,
  )

  test(
    'failover: the first account answering 429 moves the turn to the second and stays marked',
    async () => {
      reset()
      const p = await profile('failover', mock, {
        rows: [vaultRow('a1', A), vaultRow('a2', A)],
        served: {
          a1: { material: 'vault-key-1' },
          a2: { material: 'vault-key-2' },
        },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p)
      mock.reply = (request) =>
        request.headers.authorization === 'Bearer vault-key-1'
          ? {
              kind: 'status',
              status: 429,
              body: '{"error":{"message":"limited-1"}}',
              headers: { 'retry-after': '120' },
            }
          : { kind: 'ok' }
      expect((await h.turn(A)).error).toBeUndefined()
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-1',
        'Bearer vault-key-2',
      ])
      mock.requests.length = 0
      expect((await h.turn(A)).error).toBeUndefined()
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-2',
      ])
      await stopAll()
    },
    timeout,
  )

  test(
    'exhaustion and 401: both 401 shows the last body and reports each served version; both 429 shows the last 429 body',
    async () => {
      reset()
      const p = await profile('exhaust', mock, {
        rows: [
          vaultRow('a1', A),
          vaultRow('a2', A),
          vaultRow('openai', 'openai'),
        ],
        served: {
          a1: { material: 'vault-key-1', recordVersion: 7 },
          a2: { material: 'vault-key-2', recordVersion: 9 },
        },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p)
      mock.reply = (request) => ({
        kind: 'status',
        status: 401,
        body: `{"error":{"message":"denied-${request.headers.authorization?.slice(-1)}"}}`,
      })
      const denied = await h.turn(A)
      expect(denied.error).toContain('denied-2')
      const reported = await reports(p)
      expect(
        reported
          .map((entry) => `${entry.credentialId}@${entry.recordVersion}`)
          .sort(),
      ).toEqual(['a1@7', 'a2@9'])
      mock.reply = (request) => ({
        kind: 'status',
        status: 429,
        body: `{"error":{"message":"limited-${request.headers.authorization?.slice(-1)}"}}`,
        headers: { 'retry-after': '120' },
      })
      const limited = await h.retrying(A)
      expect(limited.message).toContain('limited-2')
      expect((await reports(p)).length).toBe(2)
      await stopAll()
    },
    timeout,
  )

  test(
    'vault unreachable: a kept key serves after one read, a 401 on it is not reported, and with no earlier read the turn fails unreachable',
    async () => {
      reset()
      const p = await profile('outage', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-kept', recordVersion: 3 } },
      })
      await p.setAuth({ [A]: placeholderA })
      let h = await host(p)
      expect((await h.turn(A)).error).toBeUndefined()
      await p.vault({ outage: true })
      mock.requests.length = 0
      expect((await h.turn(A)).error).toBeUndefined()
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer vault-key-kept',
      ])
      mock.reply = () => ({
        kind: 'status',
        status: 401,
        body: '{"error":{"message":"kept-denied"}}',
      })
      expect((await h.turn(A)).error).toContain('kept-denied')
      expect(await reports(p)).toEqual([])
      await stopAll()
      reset()
      h = await host(p)
      const result = await h.turn(A)
      expect(result.error).toContain('could not be reached')
      expect(mock.requests).toEqual([])
      await stopAll()
    },
    timeout,
  )

  test(
    "a user's stored key and env key pass unchanged and block /claustrum use; release leaves a user login",
    async () => {
      reset()
      const p = await profile('user-keys', mock, {
        rows: [vaultRow('a', A), vaultRow('b', 'fixture-b')],
        served: {
          a: { material: 'vault-key-a' },
          b: { material: 'vault-key-b' },
        },
      })
      await p.setAuth({ 'fixture-b': { type: 'api', key: 'user-stored-key' } })
      const h = await host(p, { FIXTURE_A_API_KEY: 'user-env-key' })
      expect((await h.turn(A)).error).toBeUndefined()
      expect((await h.turn('fixture-b')).error).toBeUndefined()
      expect(turns().map((r) => r.headers.authorization)).toEqual([
        'Bearer user-env-key',
        'Bearer user-stored-key',
      ])
      expect(await gets(p)).toEqual([])
      expect(await reports(p)).toEqual([])
      const session = await h.session()
      const env = await h.command(session, `use ${A}`)
      expect(env).toContain('FIXTURE_A_API_KEY')
      const stored = await h.command(session, 'use fixture-b')
      expect(stored).toContain('opencode auth logout fixture-b')
      expect(await p.auth()).toEqual({
        'fixture-b': { type: 'api', key: 'user-stored-key' },
      })
      // A login completed through the host's own auth API just before
      // `use` or `release`.
      const login = await h.api('PUT', `/auth/${A}`, {
        type: 'api',
        key: 'user-login-key',
      })
      expect(login.ok).toBe(true)
      expect(await h.command(session, `use ${A}`)).toContain(
        'opencode auth logout',
      )
      expect(await h.command(session, `release ${A}`)).toContain(
        'left as it is',
      )
      expect((await p.auth())[A]).toEqual({
        type: 'api',
        key: 'user-login-key',
      })
      await stopAll()
    },
    timeout,
  )

  test(
    'a stored placeholder with the env variable set is refused as shadowed and nothing is sent or read',
    async () => {
      reset()
      const p = await profile('shadow', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-a' } },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p, { FIXTURE_A_API_KEY: 'user-env-key' })
      const result = await h.turn(A)
      expect(result.error).toContain('FIXTURE_A_API_KEY is shadowed')
      expect(result.error).toContain('release fixture-a')
      expect(mock.requests).toEqual([])
      expect(await gets(p)).toEqual([])
      await stopAll()
    },
    timeout,
  )

  test(
    'a differently cased env variable: the shadow check and /claustrum use agree with what the host resolves',
    async () => {
      reset()
      const p = await profile('env-case', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-a' } },
      })
      const env = { Fixture_A_Api_Key: 'mixed-case-key' }
      let h = await host(p, env)
      // Probe the host's own lookup with an empty slot.
      await h.turn(A)
      const hostResolves = bearers().includes('Bearer mixed-case-key')
      const session = await h.session()
      const shown = await h.command(session, `use ${A}`)
      if (hostResolves) {
        expect(shown).toContain('Fixture_A_Api_Key')
        expect((await p.auth())[A]).toBeUndefined()
      } else {
        expect(shown).toContain('now uses the vault')
        await stopAll()
        reset()
        h = await host(p, env)
        expect((await h.turn(A)).error).toBeUndefined()
        expect(turns().map((r) => r.headers.authorization)).toEqual([
          'Bearer vault-key-a',
        ])
      }
      // The case rule the host follows on this OS, recorded in the output.
      console.log(`host resolves a differently cased variable: ${hostResolves}`)
      if (process.platform !== 'win32') expect(hostResolves).toBe(false)
      await stopAll()
    },
    timeout,
  )

  test(
    'release, then restart: the provider stays released and unowned',
    async () => {
      reset()
      const p = await profile('release', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-a' } },
      })
      let h = await host(p)
      const session = await h.session()
      expect(await h.command(session, `use ${A}`)).toContain(
        'now uses the vault',
      )
      expect(await h.command(session, `release ${A}`)).toContain(
        'placeholder removed',
      )
      expect((await p.auth())[A]).toBeUndefined()
      await stopAll()
      h = await host(p)
      // With no stored key the host sends the request without one; the plugin
      // does not own it, so neither a vault key nor the placeholder goes out.
      await h.turn(A)
      expect(bearers().filter((value) => value?.includes('vault-key'))).toEqual(
        [],
      )
      expect(wire(mock)).not.toContain(placeholderOf(A))
      expect(await gets(p)).toEqual([])
      expect((await p.auth())[A]).toBeUndefined()
      await stopAll()
    },
    timeout,
  )

  test(
    'rows vanish while owned: requests refuse locally and the placeholder stays',
    async () => {
      reset()
      const p = await profile('vanish', mock, {
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-a' } },
      })
      await p.setAuth({ [A]: placeholderA })
      const h = await host(p)
      expect((await h.turn(A)).error).toBeUndefined()
      await p.vault({ rows: [] })
      // Wait for the plugin to apply the emptied roster, not just to start
      // listing it: the roster file commit can land well after the new list
      // on a slow runner, and a turn in between still routes on the old row.
      // Each `accounts` read refreshes the hub first and only resolves once
      // the new roster is committed and installed, so polling it waits for
      // the applied state the turn needs. A turn sent too early would still
      // refuse locally (the hub fails the stale route before any provider
      // dispatch), but with the consumer's "disabled, removed or changed"
      // text instead of "no vault account".
      const session = await h.session()
      const appliedBy = Date.now() + 120_000
      for (;;) {
        const accounts = await h.command(session, 'accounts')
        if (accounts.includes(`${A}: 0 vault account(s)`)) break
        if (Date.now() > appliedBy)
          throw new Error(
            `the emptied roster was not applied in time:\n${accounts}`,
          )
        await Bun.sleep(500)
      }
      mock.requests.length = 0
      const result = await h.turn(A)
      expect(result.error).toContain('no vault account')
      expect(mock.requests).toEqual([])
      expect((await p.auth())[A]).toEqual(placeholderA)
      await stopAll()
    },
    timeout,
  )

  test(
    'vault down at start, then up: /claustrum use works without a restart',
    async () => {
      reset()
      const p = await profile('boot-outage', mock, {
        outage: true,
        rows: [vaultRow('a', A)],
        served: { a: { material: 'vault-key-a' } },
      })
      const h = await host(p)
      const session = await h.session()
      expect(await h.command(session, `use ${A}`)).toContain('no vault account')
      expect((await p.auth())[A]).toBeUndefined()
      await p.vault({ outage: false })
      expect(await h.command(session, `use ${A}`)).toContain(
        'now uses the vault',
      )
      expect((await p.auth())[A]).toEqual(placeholderA)
      await stopAll()
    },
    timeout,
  )
})
