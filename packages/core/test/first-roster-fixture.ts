import { onTestFinished } from 'bun:test'
import { firstRosterClock } from '../src/first-roster.ts'
import type { harness } from './fakes.ts'

export function fakeFirstRosterClock() {
  const original = firstRosterClock.schedule
  let now = 0
  const scheduled = Promise.withResolvers<void>()
  const timers = new Map<object, { at: number; run: () => void }>()
  firstRosterClock.schedule = (run, ms) => {
    const key = {}
    timers.set(key, { at: now + ms, run })
    scheduled.resolve()
    return () => {
      timers.delete(key)
    }
  }
  onTestFinished(() => {
    firstRosterClock.schedule = original
  })
  return {
    scheduled: scheduled.promise,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms
      for (const [key, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(key)
        timer.run()
      }
    },
  }
}

export async function gateFirstDiscovery(
  h: Awaited<ReturnType<typeof harness>>,
) {
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const list = h.client.listScoped.bind(h.client)
  h.client.listScoped = async (...args) => {
    started.resolve()
    await gate.promise
    return list(...args)
  }
  const discovery = h.hub.refresh()
  await started.promise
  return { discovery, release: () => gate.resolve() }
}
