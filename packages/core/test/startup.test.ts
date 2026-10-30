import { expect, test } from 'bun:test'
import { startupRefusal, startupStep, startupSync } from '../src/startup.ts'

test('startup errors use fixed operations, remedies and filesystem reasons, never native paths or provider text', () => {
  const native = Object.assign(new Error('provider text with a secret'), {
    code: 'EACCES',
    path: '/private/profile/token.json',
  })
  const failure = startupRefusal('pi-state', native)
  expect(failure.message).toContain('open the Pi claustrum-auth state folder')
  expect(failure.message).toContain('Access was denied.')
  expect(failure.message).toContain(
    'owned by your user, owner-only and writable, then restart Pi',
  )
  expect(failure.message).not.toMatch(
    /provider text|secret|\/private|token.json/,
  )
  expect(failure.cause).toBeUndefined()
  expect(failure.stack).not.toContain(native.message)
})

test('unknown codes and hostile diagnostic properties are never printed or evaluated', () => {
  let reads = 0
  const getter = Object.defineProperty(new Error('untrusted'), 'code', {
    get() {
      reads++
      throw new Error('must not read')
    },
  })
  for (const error of [
    Object.assign(new Error('untrusted'), { code: 'provider-secret' }),
    Object.assign(new Error('untrusted'), { code: '__proto__' }),
    getter,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('untrusted')
        },
      },
    ),
    undefined,
  ]) {
    const failure = startupRefusal('pi-register', error)
    expect(failure.message).toBe(
      'claustrum-auth did not start: could not register Pi providers from models.json and the model catalog. Check models.json for invalid or empty provider definitions, then restart Pi.',
    )
  }
  expect(reads).toBe(0)
})

test('nested startup boundaries retain the most specific safe operation', async () => {
  const specific = startupRefusal('opencode-state-read', { code: 'EISDIR' })
  expect(() =>
    startupSync('opencode-start', () => {
      throw specific
    }),
  ).toThrow(specific)
  await expect(
    startupStep('opencode-start', async () => {
      throw specific
    }),
  ).rejects.toBe(specific)
})
