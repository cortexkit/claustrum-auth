// A failure-only phase clock for tests that run close to Bun's 5 s default on
// slow CI machines (Windows above all). A test marks each phase as it ends;
// nothing is printed unless the test is still running after `limitMs`, or
// finishes later than that, so a slow run shows which phase took the time.
export function phaseClock(name: string, limitMs = 4_000) {
  const started = performance.now()
  const phases: string[] = []
  const elapsed = () => Math.round(performance.now() - started)
  const report = (why: string) =>
    console.error(`${name} phases (${why}): ${phases.join(', ') || 'none'}`)
  const timer = setTimeout(
    () => report(`still running at ${limitMs} ms`),
    limitMs,
  )
  timer.unref?.()
  return {
    /** Records that the phase `label` ended now. */
    mark(label: string) {
      phases.push(`${label} +${elapsed()}ms`)
    },
    /** Ends the clock; prints every phase if the test ran past the limit. */
    done() {
      clearTimeout(timer)
      if (elapsed() > limitMs) report(`took ${elapsed()} ms`)
    },
  }
}
