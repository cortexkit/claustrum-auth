import { expect, test } from 'bun:test'
import {
  type ActivationState,
  type Host,
  initialActivation,
  SlotQueue,
  transitionActivation,
} from '../test-entry.ts'

function start(host: Host, flags = {}, placeholder = false, vaultOn = true) {
  return transitionActivation(initialActivation(host, flags), {
    type: 'start',
    listed: true,
    placeholder,
    vaultOn,
  })
}
function activate(state: ActivationState, extra = {}) {
  return transitionActivation(state, {
    type: 'activate',
    vaultOn: true,
    routable: true,
    ...extra,
  })
}

test('activation registers without rows during outage and never automatically enters OpenCode', () => {
  for (const host of ['opencode1', 'opencode2', 'pi'] as const) {
    const result = start(host)
    expect(result.effects).toEqual(['register-available'])
    expect(result.state.status).toBe('available')
    expect(result.state.routable).toBe(false)
    const unlisted = transitionActivation(initialActivation(host), {
      type: 'start',
      listed: false,
      placeholder: true,
      vaultOn: true,
    })
    expect(unlisted.state.status).toBe('unlisted')
    expect(unlisted.effects).toEqual([])
    if (host !== 'pi')
      expect(
        transitionActivation(result.state, {
          type: 'discovery',
          routable: true,
        }).effects,
      ).toEqual([])
  }
})

test('activation refusals change neither state nor persisted flags', () => {
  const state = start('pi').state
  for (const [extra, refusal] of [
    [{ vaultOn: false }, 'vault-mode-off'],
    [{ routable: false }, 'no-vault-account'],
    [{}, 'consent-required'],
  ] as const) {
    const result = activate(state, extra)
    expect(result.refusal).toBe(refusal)
    expect(result.state).toBe(state)
    expect(result.effects).toEqual([])
  }
  expect(
    activate(start('opencode1').state, { effectiveKey: true }).refusal,
  ).toBe('credential-shadowed')
  expect(activate(initialActivation('opencode2')).refusal).toBe(
    'no-vault-account',
  )
})

test('Pi automatic entry waits for first successful discovery and persisted release survives restart', () => {
  let state = start('pi', { consented: true }).state
  state = transitionActivation(state, {
    type: 'authority',
    vaultOn: true,
  }).state
  state = transitionActivation(state, {
    type: 'discovery',
    routable: false,
  }).state
  const entered = transitionActivation(state, {
    type: 'discovery',
    routable: true,
  })
  expect(entered.effects).toEqual(['register-owned', 'enter-slot'])
  state = transitionActivation(entered.state, {
    type: 'entered',
    success: true,
    wrote: true,
  }).state
  const released = transitionActivation(state, { type: 'release' })
  expect(released.effects).toEqual(['persist-flags', 'exit-slot'])
  expect(released.state.released).toBe(true)
  const restarted = start('pi', {
    consented: released.state.consented,
    released: released.state.released,
  }).state
  expect(
    transitionActivation(restarted, { type: 'discovery', routable: true })
      .effects,
  ).toEqual([])
  const explicit = activate(restarted)
  expect(explicit.state.released).toBe(false)
  expect(explicit.effects).toEqual([
    'persist-flags',
    'register-owned',
    'enter-slot',
  ])
})

test('owned providers stay owned when rows vanish and only Pi exits on local authority loss', () => {
  for (const host of ['opencode1', 'opencode2', 'pi'] as const) {
    const owned = start(host, {}, true).state
    const vanished = transitionActivation(owned, {
      type: 'discovery',
      routable: false,
    })
    expect(vanished.state.status).toBe('owned')
    expect(vanished.effects).toEqual([])
    const local = transitionActivation(vanished.state, {
      type: 'authority',
      vaultOn: false,
    })
    expect(local.state.status).toBe('owned')
    expect(local.effects).toEqual(host === 'pi' ? ['exit-slot'] : [])
  }
  const crashWithLocal = start('pi', {}, true, false)
  expect(crashWithLocal.effects).toEqual(['register-owned', 'exit-slot'])
})

test('Pi enter exit ordering rolls back only when nothing was written and conflicts retain the guard', () => {
  const available = start('pi').state
  const entering = activate(available, { consented: true })
  expect(entering.effects).toEqual([
    'persist-flags',
    'register-owned',
    'enter-slot',
  ])
  expect(entering.state.status).toBe('owned')
  const failed = transitionActivation(entering.state, {
    type: 'entered',
    success: false,
    wrote: false,
  })
  expect(failed.state.status).toBe('available')
  expect(failed.effects).toEqual(['register-available', 'refresh-registry'])
  const partial = transitionActivation(entering.state, {
    type: 'entered',
    success: false,
    wrote: true,
  })
  expect(partial.state.status).toBe('owned')
  expect(partial.effects).toEqual(['refresh-registry'])
  const release = transitionActivation(partial.state, { type: 'release' })
  expect(release.effects).toEqual(['persist-flags', 'exit-slot'])
  const conflict = transitionActivation(release.state, {
    type: 'exited',
    success: false,
  })
  expect(conflict.state.status).toBe('owned')
  expect(conflict.effects).toEqual([])
  const success = transitionActivation(release.state, {
    type: 'exited',
    success: true,
  })
  expect(success.state.status).toBe('available')
  expect(success.effects).toEqual(['register-available', 'refresh-registry'])
})

test('one Pi slot queue serializes providers and recovers after a rejection', async () => {
  const queue = new SlotQueue()
  const events: string[] = []
  let unblock!: () => void
  const held = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const first = queue.run(async () => {
    events.push('first')
    await held
    throw new Error('slot-conflict')
  })
  const second = queue.run(async () => {
    events.push('second')
  })
  await Promise.resolve()
  expect(events).toEqual(['first'])
  unblock()
  await expect(first).rejects.toThrow('slot-conflict')
  await second
  expect(events).toEqual(['first', 'second'])
})
