// The shipped supported-provider table on the OpenCode 1 entry: the config
// hook wraps every live provider it lists, a vault row for one of them is
// served with its key, and only to that provider's documented origin.
import { expect, test } from 'bun:test'
import { liveHarness, row } from '../../core/test/fakes.ts'
import { supportedProviders, tableByService } from '../../core/test-entry.ts'
import { providerFetch } from '../src/v1/fetch.ts'
import { placeholderFor } from '../src/v1/placeholder.ts'

test('a live provider is served with its vault key to its origin, and a lookalike origin is refused', async () => {
  for (const service of ['cerebras', 'fireworks', 'kimi-coding']) {
    const entry = tableByService.get(service)
    if (!entry) throw new Error(`no ${service} entry`)
    const provider = entry.hosts.opencode1 as string
    const origin = new URL(entry.origins[0] as string)
    const h = await liveHarness(
      [row(`apikey:${service}`, { providerIds: [provider] })],
      'opencode1',
    )
    const consumer = h.consumers.get(provider)
    if (!consumer) throw new Error(`no ${provider} member on OpenCode 1`)
    const calls: { auth: string | null; url: string }[] = []
    const fetch = providerFetch({
      provider,
      entry,
      consumer,
      previous: async () => new Response('foreign'),
      transport: async (input) => {
        const request = input as Request
        calls.push({
          auth: request.headers.get('authorization'),
          url: request.url,
        })
        return new Response('ok')
      },
      envNames: async () => [],
      env: () => ({}),
      platform: 'linux',
    })
    const placeholder = placeholderFor(provider)
    const url = new URL('/v1/chat/completions', origin).href
    expect(
      await (
        await fetch(url, {
          headers: { authorization: `Bearer ${placeholder}` },
        })
      ).text(),
    ).toBe('ok')
    expect(calls.at(-1)).toEqual({
      auth: `Bearer secret-apikey:${service}-1`,
      url,
    })
    for (const lookalike of [
      `${origin.protocol}//${origin.hostname}.example`,
      `${origin.protocol}//${origin.hostname}:8443`,
      `http://${origin.hostname}`,
    ]) {
      await expect(
        fetch(new URL('/v1/chat/completions', lookalike).href, {
          headers: { authorization: `Bearer ${placeholder}` },
        }),
      ).rejects.toMatchObject({
        name: 'ClaustrumRefusal',
        code: 'origin-refused',
      })
    }
    // A refusal reads nothing: one row, one read for the served request.
    expect(h.reads).toEqual([`apikey:${service}`])
  }
})

test('every live provider OpenCode 1 lists has a member, and no fixture provider has one', async () => {
  const rows = supportedProviders.flatMap((entry) => {
    const provider = entry.hosts.opencode1
    return provider
      ? [row(`apikey:${entry.service}`, { providerIds: [provider] })]
      : []
  })
  const h = await liveHarness(rows, 'opencode1')
  expect([...h.consumers.keys()].sort()).toEqual(
    supportedProviders.flatMap((entry) => entry.hosts.opencode1 ?? []).sort(),
  )
  expect([...h.consumers.keys()].some((id) => id.startsWith('fixture-'))).toBe(
    false,
  )
  for (const consumer of h.consumers.values())
    expect(consumer.routingRows().length).toBe(1)
})
