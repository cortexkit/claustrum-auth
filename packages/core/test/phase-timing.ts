// These fixture-backed tests run serially. Capture the clock when constructing
// a fixture so its completion hook can record work after the body ends.
let active: ReturnType<typeof phaseTiming> | undefined

// Durations are inclusive: nested vault calls also appear in refresh/dispatch.
// A watchdog reports unfinished phases before Bun's default timeout fires.
function phaseTiming(name: string) {
  const started = performance.now()
  let deferred = false
  const phases = new Map<string, { count: number; ms: number }>()
  const pending = new Map<object, string>()
  const report = (why: string) => {
    console.error(
      `[test-timing] ${name} ${why} ${JSON.stringify({
        totalMs: Math.round(performance.now() - started),
        phases: Object.fromEntries(
          [...phases].map(([label, value]) => [
            label,
            { ...value, ms: Math.round(value.ms) },
          ]),
        ),
        pending: [...pending.values()],
      })}`,
    )
  }
  const timer = setTimeout(() => report('still running'), 4000)
  timer.unref?.()
  return {
    defer() {
      deferred = true
    },
    bodyDone() {
      if (!deferred) this.done()
    },
    async phase<T>(label: string, run: () => T | Promise<T>): Promise<T> {
      const key = {}
      pending.set(key, label)
      const start = performance.now()
      try {
        return await run()
      } finally {
        pending.delete(key)
        const value = phases.get(label) ?? { count: 0, ms: 0 }
        value.count++
        value.ms += performance.now() - start
        phases.set(label, value)
      }
    },
    done() {
      clearTimeout(timer)
      if (
        process.env.CLAUSTRUM_AUTH_TEST_TIMING === '1' ||
        performance.now() - started >= 4000
      )
        report('finished')
    },
  }
}

export function withTestTiming(name: string, run: () => Promise<void>) {
  const timing = phaseTiming(name)
  const previous = active
  active = timing
  return (async () => {
    try {
      await run()
    } finally {
      active = previous
      timing.bodyDone()
    }
  })()
}

// Use the fixture's existing completion hook, including its flush/dispose work.
export function deferTestTiming() {
  const timing = active
  timing?.defer()
  return () => timing?.done()
}

export function testTiming() {
  return (
    active ?? {
      phase: async <T>(_label: string, run: () => T | Promise<T>) => run(),
    }
  )
}

export function hasTestTiming() {
  return active !== undefined
}
