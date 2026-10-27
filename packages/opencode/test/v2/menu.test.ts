import { expect, test } from 'bun:test'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { row, startServer } from './fakes.ts'

test('OpenCode 2 claustrum command renders status, accounts and refusals and applies the requested vault order', async () => {
  // Failure-only phase clock: this test once took 5.5 s on Windows CI against
  // about 2 s before, so a repeat prints which step took the time.
  const started = performance.now()
  const phases: string[] = []
  const mark = (label: string) =>
    phases.push(`${label} +${Math.round(performance.now() - started)}ms`)
  const timer = setTimeout(
    () => console.error(`menu test phases: ${phases.join(', ')}`),
    4_500,
  )
  timer.unref?.()
  const { host, vault } = await startServer({
    rows: [
      row('first'),
      row('second'),
      row('reserved', { providerIds: ['openai'] }),
    ],
  })
  mark('server')
  const command = host.commands.get('claustrum')
  expect(command).toBeDefined()
  const run = async (text: string) => {
    await command?.execute({ sessionID: 'invoking-session', prompt: { text } })
    mark(text.split(' ').slice(0, 2).join(' '))
    expect(host.synthetic.at(-1)).toMatchObject({
      sessionID: 'invoking-session',
      resume: false,
    })
    return host.synthetic.at(-1)?.text ?? ''
  }
  expect(await run('/claustrum status')).toContain('Vault mode: on')
  host.selected.set('fixture-a', {
    type: 'oauth',
    access: placeholderSecret('fixture-a'),
  })
  expect(await run('status')).toContain('fixture-a: owned')
  host.selected.set('fixture-a', { type: 'key', key: 'user key' })
  expect(await run('status')).toContain('fixture-a: available')
  const accounts = await run('accounts')
  const ids = [...accounts.matchAll(/\[(vault:[^\]]+)\]/gu)].map(
    (match) => match[1],
  )
  expect(ids).toHaveLength(2)
  expect(await run(`reorder fixture-a ${ids[1]} ${ids[0]}`)).toContain(
    'order reordered',
  )
  const after = await run('accounts')
  expect(after.indexOf(ids[1] as string)).toBeLessThan(
    after.indexOf(ids[0] as string),
  )
  expect(await run('refusals')).toContain('reserved: reserved-provider')
  vault.mode = 'local'
  expect(await run('status')).toContain('Vault mode: off')
  expect(await run(`reorder fixture-a ${ids[0]} ${ids[1]}`)).toContain(
    'no order was changed',
  )
  expect(vault.reads).toEqual([])
  clearTimeout(timer)
})
