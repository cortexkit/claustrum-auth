import { describe, expect, test } from 'bun:test'
import {
  type BillingProbe,
  type BillingReport,
  billingChecks,
} from './billing.ts'

const report = (usage?: BillingReport['usage']): BillingReport => ({
  kind: 'billing',
  request_kind: 'primary',
  provider: 'synthetic',
  model: 'model',
  outcome: 'completed',
  ...(usage ? { usage } : {}),
})
const probe = (
  name: BillingProbe['name'],
  usage?: BillingReport['usage'],
  reply = 'OK',
): BillingProbe => ({
  name,
  model: 'model',
  session: 'session',
  reports: [report(usage)],
  reply,
  stored: [],
})
const cacheCheck = (
  first: BillingReport['usage'],
  second: BillingReport['usage'],
) => billingChecks([probe('long-1', first), probe('long-2', second)])[0]
const reasoningCheck = (usage?: BillingReport['usage'], reply = 'OK') =>
  billingChecks([probe('reasoning', usage, reply)])[1]

describe('billing report checks', () => {
  test('included-cache counts PASS after restoring the subtracted hit', () => {
    expect(
      cacheCheck(
        { input: 5000, output: 1 },
        { input: 4000, output: 1, cache_read: 1000 },
      ),
    ).toMatchObject({ verdict: 'PASS' })
  })

  test('excluded-cache counts FAIL when the table subtracted cache twice', () => {
    const result = cacheCheck(
      { input: 5000, output: 1 },
      { input: 3000, output: 1, cache_read: 1000 },
    )
    expect(result.verdict).toBe('FAIL')
    expect(result.reason).toContain('prompt likely excludes cache')
  })

  test('no second-turn hit is UNTESTED, including an explicit zero', () => {
    for (const cache_read of [undefined, 0]) {
      expect(
        cacheCheck(
          { input: 5000, output: 1 },
          { input: 5000, output: 1, cache_read },
        ),
      ).toMatchObject({
        verdict: 'UNTESTED',
        reason: expect.stringContaining('no hit'),
      })
    }
  })

  test('restores writes and first-turn hits before comparing identical contexts', () => {
    expect(
      cacheCheck(
        { input: 3500, output: 1, cache_read: 1000, cache_write: 500 },
        { input: 500, output: 1, cache_read: 4000, cache_write: 500 },
      ).verdict,
    ).toBe('PASS')
  })

  test('two percent is inclusive; a larger mismatch fails', () => {
    for (const [input, verdict] of [
      [4100, 'PASS'],
      [4101, 'FAIL'],
    ] as const) {
      expect(
        cacheCheck({ input: 5000 }, { input, cache_read: 1000 }).verdict,
      ).toBe(verdict)
    }
  })

  test('a hit without both completed primary input counts is UNTESTED', () => {
    expect(cacheCheck(undefined, { input: 0, cache_read: 5000 }).verdict).toBe(
      'UNTESTED',
    )
    const cut = probe('long-1', { input: 5000 })
    cut.reports[0].outcome = 'cut'
    expect(
      billingChecks([cut, probe('long-2', { input: 0, cache_read: 5000 })])[0]
        .verdict,
    ).toBe('UNTESTED')
  })

  test('reasoning included in output PASSes when visible tokens match chars/4', () => {
    expect(
      reasoningCheck({ input: 10, output: 101, reasoning: 100 }).verdict,
    ).toBe('PASS')
  })

  for (const [provider, output, reasoning, storedOutput] of [
    ['DeepSeek', 43, 41, 2],
    ['Kimi', 53, 39, 14],
    ['Cerebras', 133, 128, 5],
  ] as const) {
    test(`live ${provider} reasoning row uses stored visible output`, () => {
      const turn = probe('reasoning', { output, reasoning }, '120')
      turn.stored = [{ tokens: { output: storedOutput } }]
      expect(billingChecks([turn])[1]).toMatchObject({
        verdict: 'PASS',
        reason: expect.stringContaining('OpenCode stored visible output'),
      })
    })
  }

  test('reasoning exceeding output FAILs', () => {
    expect(reasoningCheck({ output: 100, reasoning: 101 })).toMatchObject({
      verdict: 'FAIL',
      reason: 'reasoning 101 exceeds output 100',
    })
  })

  test('stored visible output takes precedence with an inclusive ±1 tolerance', () => {
    for (const [output, verdict] of [
      [1, 'PASS'],
      [3, 'PASS'],
      [0, 'FAIL'],
      [4, 'FAIL'],
    ] as const) {
      const turn = probe('reasoning', { output: 102, reasoning: 100 })
      turn.stored = [{ tokens: { output } }]
      expect(billingChecks([turn])[1].verdict).toBe(verdict)
    }
    const zero = probe('reasoning', { output: 100, reasoning: 100 }, '')
    zero.stored = [{ tokens: { output: 0 } }]
    expect(billingChecks([zero])[1].verdict).toBe('PASS')
  })

  test('reasoning exceeding output FAILs even when stored output is available', () => {
    const turn = probe('reasoning', { output: 100, reasoning: 101 })
    turn.stored = [{ tokens: { output: 0 } }]
    expect(billingChecks([turn])[1].verdict).toBe('FAIL')
  })

  test('fallback accepts short replies within ±8 tokens, not beyond', () => {
    for (const [output, verdict] of [
      [109, 'PASS'],
      [110, 'FAIL'],
    ] as const) {
      expect(reasoningCheck({ output, reasoning: 100 }, '1234').verdict).toBe(
        verdict,
      )
    }
  })

  test('reasoning difference outside both fallback tolerances FAILs', () => {
    for (const output of [301, 149])
      expect(
        reasoningCheck({ output, reasoning: 100 }, 'x'.repeat(400)).verdict,
      ).toBe('FAIL')
  })

  test('missing reasoning count is UNTESTED rather than invented zero', () => {
    expect(reasoningCheck({ output: 1 }).verdict).toBe('UNTESTED')
    expect(reasoningCheck({ output: 1, reasoning: 0 }).verdict).toBe('PASS')
    expect(reasoningCheck({ reasoning: 100 }).verdict).toBe('UNTESTED')
    expect(billingChecks([])[1].verdict).toBe('UNTESTED')
  })

  test('an empty visible reply cannot produce a reasoning PASS', () => {
    expect(reasoningCheck({ output: 100, reasoning: 100 }, '').verdict).toBe(
      'FAIL',
    )
  })

  test('every completed report needs usage input and output, retaining measured zero', () => {
    const reports = [report(), report({ input: 1 }), report({ output: 1 })]
    expect(billingChecks([], reports)[2]).toMatchObject({
      verdict: 'FAIL',
      reason: '3/3 completed reports missing usage.input or usage.output',
    })
    expect(
      billingChecks([], [report({ input: 0, output: 0 })])[2].verdict,
    ).toBe('PASS')
    reports[0].outcome = 'failed'
    expect(billingChecks([], [reports[0]])[2].verdict).toBe('UNTESTED')
  })

  test('raw host counters are not cache verdict inputs', () => {
    const probes = [
      probe('long-1', { input: 5000 }),
      probe('long-2', { input: 4000, cache_read: 1000 }),
    ]
    probes[1].stored = [{ tokens: { input: 999999, output: 999999 } }]
    expect(billingChecks(probes)[0].verdict).toBe('PASS')
  })
})
