import { expect, test } from 'bun:test'
import {
  checkPlacement,
  createFetch,
  fixtureEntries,
  servingCallbacks,
  supportedProviders,
} from '../test-entry.ts'
import { bearer, harness, placeholder, row } from './fakes.ts'

test('placement counts every carrier before any vault read or request edit', async () => {
  const h = await harness()
  let sends = 0
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    fetch: async () => {
      sends++
      return new Response()
    },
  })
  for (const name of ['x-api-key', 'x-goog-api-key', 'api-key', 'x-extra']) {
    for (const headers of [
      { [name]: placeholder },
      { ...bearer, [name]: placeholder },
    ]) {
      const request = new Request('https://fixture.invalid/request', {
        method: 'POST',
        headers,
        body: 'unchanged',
      })
      await expect(fetch(request)).rejects.toMatchObject({
        code: 'placement-refused',
      })
      expect(await request.text()).toBe('unchanged')
      expect(request.headers.get(name)).toBe(placeholder)
    }
  }
  for (const authorization of [
    placeholder,
    `Basic ${placeholder}`,
    `Bearer ${placeholder}, Bearer ${placeholder}`,
  ]) {
    await expect(
      fetch('https://fixture.invalid', { headers: { authorization } }),
    ).rejects.toMatchObject({ code: 'placement-refused' })
  }
  for (const query of [
    `?key=${placeholder}`,
    `?${placeholder}=value`,
    `?key=${placeholder}&other=${placeholder}`,
  ]) {
    await expect(
      fetch(`https://fixture.invalid${query}`, { headers: bearer }),
    ).rejects.toMatchObject({ code: 'placement-refused' })
    await expect(
      fetch(`https://fixture.invalid${query}`),
    ).rejects.toMatchObject({ code: 'placement-refused' })
  }
  expect(h.reads).toEqual([])
  expect(sends).toBe(0)
})

test('origin guard refuses scheme host port and credentials before vault reads on HTTP and handshake', async () => {
  const h = await harness()
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
  }
  const fetch = createFetch({
    ...options,
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  const callbacks = servingCallbacks(options)
  for (const url of [
    'http://fixture.invalid',
    'https://other.invalid',
    'https://fixture.invalid:444',
    'wss://other.invalid',
    'https://user:pass@fixture.invalid',
  ]) {
    await expect(fetch(url, { headers: bearer })).rejects.toMatchObject({
      code: 'origin-refused',
    })
    await expect(
      callbacks.request(new URL(url), new Headers(bearer)),
    ).rejects.toMatchObject({ code: 'origin-refused' })
  }
  expect(h.reads).toEqual([])
  expect(
    checkPlacement(
      new URL('https://fixture.invalid:443'),
      new Headers(bearer),
      placeholder,
      fixtureEntries[0],
    ),
  ).toBe('bearer')
  expect(
    checkPlacement(
      new URL('wss://fixture.invalid:443'),
      new Headers(bearer),
      placeholder,
      fixtureEntries[0],
    ),
  ).toBe('bearer')
  expect(
    checkPlacement(
      new URL('http://127.0.0.1:8123'),
      new Headers(bearer),
      placeholder,
      fixtureEntries[0],
    ),
  ).toBe('bearer')
  for (const url of [
    'http://localhost:8123',
    'http://[::1]:8123',
    'http://127.0.0.1:8124',
  ])
    expect(() =>
      checkPlacement(
        new URL(url),
        new Headers(bearer),
        placeholder,
        fixtureEntries[0],
      ),
    ).toThrow('origin-refused')
  // The shipped table names only the providers' own https origins: a loopback
  // mock, a fixture service or a `wss` handshake never reaches the published
  // build, which is what keeps the test harness out of it.
  for (const entry of supportedProviders) {
    expect(entry.service).not.toMatch(/^fixture-/u)
    expect(entry.origins.length).toBeGreaterThan(0)
    for (const origin of entry.origins) {
      const url = new URL(origin)
      expect(url.protocol).toBe('https:')
      expect(url.pathname).toBe('/')
      expect(url.hostname).not.toMatch(
        /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/u,
      )
    }
  }
  expect(fixtureEntries.map((entry) => entry.service)).toEqual([
    'fixture-a',
    'fixture-b',
    'fixture-c',
  ])
})

test('class C and D requests get zero vault reads even with a bearer placeholder', async () => {
  const h = await harness([row('c', { providerIds: ['fixture-c'] })])
  const consumer = h.consumers.get('fixture-c')
  if (!consumer) throw new Error('missing fixture-c member')
  for (const cls of ['C', 'D'] as const) {
    const options = {
      entry: { ...fixtureEntries[2], class: cls },
      placeholder,
      consumer,
    }
    const fetch = createFetch({ ...options, fetch: async () => new Response() })
    await expect(
      fetch('https://fixture.invalid', { headers: bearer }),
    ).rejects.toMatchObject({ code: 'placement-refused' })
    await expect(
      servingCallbacks(options).request(
        new URL('https://fixture.invalid'),
        new Headers(bearer),
      ),
    ).rejects.toMatchObject({ code: 'placement-refused' })
  }
  expect(h.reads).toEqual([])
})

test('foreign fetch inputs and callbacks pass through untouched', async () => {
  const h = await harness()
  const request = new Request('https://unlisted.invalid', {
    method: 'POST',
    headers: { authorization: 'Bearer user-key' },
    body: 'original',
  })
  const init = { headers: { 'x-api-key': 'user-key' } }
  let received: unknown[] = []
  const options = {
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
  }
  const fetch = createFetch({
    ...options,
    effectiveCredential: () => {
      throw new Error('foreign must bypass')
    },
    fetch: async (...args) => {
      received = args
      return new Response('foreign')
    },
  })
  expect(await (await fetch(request, init)).text()).toBe('foreign')
  expect(received[0]).toBe(request)
  expect(received[1]).toBe(init)
  expect(await request.text()).toBe('original')
  expect(
    await servingCallbacks(options).request(
      new URL(request.url),
      request.headers,
    ),
  ).toBeUndefined()
  expect(h.reads).toEqual([])
})

test('effective credential is checked afresh per owned request before buffering or reading vault', async () => {
  const h = await harness()
  let shadowed = false
  const fetch = createFetch({
    entry: fixtureEntries[0],
    placeholder,
    consumer: h.consumer,
    effectiveCredential: () => shadowed,
    fetch: async () => new Response('ok'),
  })
  await fetch('https://fixture.invalid', { headers: bearer })
  shadowed = true
  const request = new Request('https://fixture.invalid', {
    method: 'POST',
    body: 'untouched',
    headers: bearer,
  })
  await expect(fetch(request)).rejects.toMatchObject({
    code: 'credential-shadowed',
  })
  expect(h.reads).toEqual(['a'])
  expect(await request.text()).toBe('untouched')
})

test('class B rewrites from the served assertion after authorize and only then places the bearer', async () => {
  const h = await harness([
    row('b', { providerIds: ['fixture-b'], accountId: undefined }),
  ])
  const consumer = h.consumers.get('fixture-b')
  if (!consumer) throw new Error('missing fixture-b member')
  const options = { entry: fixtureEntries[1], placeholder, consumer }
  let observed = ''
  const fetch = createFetch({
    ...options,
    fetch: async (input) => {
      const request = input as Request
      observed = request.url
      expect(request.headers.get('authorization')).toBe('Bearer served-b')
      return new Response('ok')
    },
  })
  h.setGet(async () => ({
    material: 'served-b',
    recordVersion: 1,
    expiresAtMs: null,
    accountId: 'new/account',
  }))
  await fetch('https://fixture.invalid/client/v4/accounts/old/model', {
    headers: bearer,
  })
  expect(observed).toBe(
    'https://fixture.invalid/client/v4/accounts/new%2Faccount/model',
  )
  const holder = await servingCallbacks(options).request(
    new URL('https://fixture.invalid/client/v4/accounts/old/model'),
    new Headers(bearer),
  )
  expect(holder?.url.href).toBe(observed)
  h.setGet(async () => ({
    material: 'served-b',
    recordVersion: 1,
    expiresAtMs: null,
  }))
  await expect(
    fetch('https://fixture.invalid/client/v4/accounts/old/model', {
      headers: bearer,
    }),
  ).rejects.toMatchObject({ code: 'account-missing' })
  expect(h.reads).toHaveLength(3)
  h.setGet(async () => ({
    material: 'served-b',
    recordVersion: 1,
    expiresAtMs: null,
    accountId: 'account',
  }))
  await expect(
    fetch('https://fixture.invalid/other', { headers: bearer }),
  ).rejects.toMatchObject({ code: 'account-path-invalid' })
  await expect(
    fetch('https://fixture.invalid/wrong/v4/accounts/old/model', {
      headers: bearer,
    }),
  ).rejects.toMatchObject({ code: 'account-path-invalid' })
  h.setGet(async () => ({
    material: 'served-b',
    recordVersion: 1,
    expiresAtMs: null,
    accountId: '..',
  }))
  await expect(
    fetch('https://fixture.invalid/client/v4/accounts/old/model', {
      headers: bearer,
    }),
  ).rejects.toMatchObject({ code: 'account-path-invalid' })
})
