/** The routing accessor receives wire-format reports (snake_case), not SDK inputs. */
export type BillingReport = {
  kind: 'billing'
  request_kind: string
  provider: string
  model: string
  outcome: string
  charge_basis?: string
  cache?: unknown
  usage?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    reasoning?: number
  }
}

export type ProbeName = 'long-1' | 'long-2' | 'reasoning'
export type BillingProbe = {
  name: ProbeName
  model: string
  session: string
  reports: BillingReport[]
  reply: string
  stored: { agent?: string; tokens?: HostTokens }[]
  captureError?: string
}
type HostTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}
export type Check = {
  check: string
  verdict: 'PASS' | 'FAIL' | 'UNTESTED'
  reason: string
}

// Roughly 3,000 tokens of fixed prose; no timestamp or provider-specific suffix
// should displace the shared prefix that automatic caches can reuse.
export const longPrompt = `${Array.from(
  { length: 110 },
  () =>
    'The quiet library keeps a careful record of every book. Each morning the librarian checks the shelves and returns every volume to its place.',
).join('\n')}\nReply with the single word OK`
export const reasoningPrompt =
  'Work out the smallest positive integer divisible by 6, 8, and 15. Reply with only the integer.'

const count = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const near = (a: number, b: number) => Math.abs(a - b) <= a * 0.02
const primary = (probe?: BillingProbe) => {
  // The accessor is session-scoped, but its payload has no session id. The
  // runner associates reports by the capture file boundaries around each send.
  const reports = probe?.reports.filter((r) => r.request_kind === 'primary')
  return reports?.length === 1 && reports[0].outcome === 'completed'
    ? reports[0]
    : undefined
}

export function billingChecks(
  probes: BillingProbe[],
  reports = probes.flatMap((p) => p.reports),
): Check[] {
  const first = primary(probes.find((p) => p.name === 'long-1'))?.usage
  const second = primary(probes.find((p) => p.name === 'long-2'))?.usage
  let prompt: Check = {
    check: 'Prompt includes cache',
    verdict: 'UNTESTED',
    reason: 'no hit (second long turn has no positive cache_read)',
  }
  if (second && count(second.cache_read) && second.cache_read > 0) {
    if (!first || !count(first.input) || !count(second.input)) {
      prompt.reason = 'missing input counts on completed long-turn reports'
    } else {
      // Reports already subtract cache from input. Restore the first turn's
      // total too, since an automatic cache can hit even on the first probe.
      const before =
        first.input + (first.cache_read ?? 0) + (first.cache_write ?? 0)
      const after = second.input + second.cache_read + (second.cache_write ?? 0)
      prompt = {
        check: prompt.check,
        verdict: near(before, after) ? 'PASS' : 'FAIL',
        reason: near(before, after)
          ? `input+cache totals ${before} vs ${after} agree within 2%`
          : `input+cache totals ${before} vs ${after} differ by >2%${near(before - second.cache_read, after) ? '; near first total minus cache_read: prompt likely excludes cache' : '; check provider semantics/context parity'}`,
      }
    }
  }

  const reasoningProbe = probes.find((p) => p.name === 'reasoning')
  const usage = primary(reasoningProbe)?.usage
  let reasoning: Check = {
    check: 'Reasoning in output',
    verdict: 'UNTESTED',
    reason: reasoningProbe
      ? 'no reasoning count on a completed primary report'
      : 'no eligible reasoning-capable model/probe',
  }
  if (usage && count(usage.reasoning)) {
    if (!count(usage.output)) reasoning.reason = 'missing output count'
    else if (usage.reasoning > usage.output)
      reasoning = {
        check: reasoning.check,
        verdict: 'FAIL',
        reason: `reasoning ${usage.reasoning} exceeds output ${usage.output}`,
      }
    else {
      const visible = usage.output - usage.reasoning
      const estimate = (reasoningProbe?.reply.length ?? 0) / 4
      reasoning = {
        check: reasoning.check,
        verdict:
          estimate > 0 && visible >= estimate / 2 && visible <= estimate * 2
            ? 'PASS'
            : 'FAIL',
        reason: `output-reasoning=${visible}; visible reply estimate=${estimate.toFixed(2)} tokens (chars/4, factor-of-two tolerance)`,
      }
    }
  }

  const completed = reports.filter((r) => r.outcome === 'completed')
  const missing = completed.filter(
    (r) => !count(r.usage?.input) || !count(r.usage?.output),
  )
  return [
    prompt,
    reasoning,
    {
      check: 'Usage present',
      verdict: missing.length ? 'FAIL' : completed.length ? 'PASS' : 'UNTESTED',
      reason: missing.length
        ? `${missing.length}/${completed.length} completed reports missing usage.input or usage.output`
        : completed.length
          ? `all ${completed.length} completed reports carry input and output`
          : 'no completed billing reports',
    },
  ]
}

/** Keep only stored accounting fields, never arbitrary message metadata. */
export function storedCounts(value: unknown): BillingProbe['stored'] {
  const messages = value as {
    data?: { type?: string; agent?: string; tokens?: HostTokens }[]
  }
  return (messages.data ?? [])
    .filter((message) => message.type === 'assistant')
    .map(({ agent, tokens }) => ({
      agent,
      ...(tokens
        ? {
            tokens: {
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cache: { read: tokens.cache?.read, write: tokens.cache?.write },
            },
          }
        : {}),
    }))
}

export function billingTable(
  provider: string,
  probes: BillingProbe[],
  reports: BillingReport[],
  cell: (text: string) => string,
) {
  const rows = billingChecks(probes, reports)
    .map((c) => `| ${c.check} | ${c.verdict} | ${cell(c.reason)} |`)
    .join('\n')
  const totals = probes
    .map((p) => {
      const context = p.stored.map(({ tokens: t }) =>
        t && count(t.input)
          ? t.input + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          : 'unavailable',
      )
      return `| ${[p.name, p.model, p.session, JSON.stringify(p.reports.map((r) => r.usage ?? null)), JSON.stringify(p.stored), context.length ? context.join(', ') : 'unavailable', p.captureError ?? ''].map(cell).join(' | ')} |`
    })
    .join('\n')
  const raw = reports
    .map(
      (r, at) =>
        `| ${[String(at + 1), r.request_kind, r.model, r.outcome, r.charge_basis ?? '(absent)', JSON.stringify(r.cache ?? null), JSON.stringify(r.usage ?? null)].map(cell).join(' | ')} |`,
    )
    .join('\n')
  return `\n## Billing: ${cell(provider)}\n\n| check | verdict | reason |\n| --- | --- | --- |\n${rows}\n\nFresh sessions, same cwd/default agent; no conversation history reused. Stored host totals are diagnostic only, not verdict inputs. Host context = stored input + cache.read + cache.write; per-session system-prompt differences are not observable from billing reports.\n\n| turn | model/variant | session | report usage | OpenCode stored agent/tokens | host context tokens | capture error |\n| --- | --- | --- | --- | --- | --- | --- |\n${totals}\n\n| report | request kind | model | outcome | chargeBasis | cache | usage |\n| --- | --- | --- | --- | --- | --- | --- |\n${raw}\n`
}
