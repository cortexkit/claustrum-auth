import { randomUUID } from 'node:crypto'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import { watchServerSentEvents } from '@cortexkit/common-auth/opencode2'
import {
  type BillingRequestKind,
  type BillingUsage,
  reportRouting,
  sessionCachePolicy,
} from '@cortexkit/common-auth/routing-accessor'
import type { ProviderEntry } from './providers.js'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function count(
  value: unknown,
  paths: readonly string[] = [],
): number | undefined {
  for (const path of paths) {
    let cursor = value
    for (const key of path.split('.'))
      cursor = object(cursor) ? cursor[key] : undefined
    if (
      typeof cursor === 'number' &&
      Number.isSafeInteger(cursor) &&
      cursor >= 0
    )
      return cursor
  }
  return undefined
}

interface RawBillingUsage {
  counts: BillingUsage
  opencode: boolean
}

/** Retain measured totals without deriving values that later chunks can change. */
function rawBillingUsage(
  entry: ProviderEntry,
  value: unknown,
): RawBillingUsage | undefined {
  const semantics = entry.billing
  if (!semantics) return undefined
  const usage: BillingUsage = {}
  const tokens =
    object(value) && object(value.usage) && object(value.usage.opencode)
      ? value.usage.opencode.tokens
      : undefined
  const opencode = !!semantics.opencodeTokens && object(tokens)
  if (opencode) {
    for (const [field, path] of [
      ['input', 'input'],
      ['output', 'output'],
      ['cacheRead', 'cache_read'],
      ['cacheWrite5m', 'cache_write_5m'],
      ['cacheWrite1h', 'cache_write_1h'],
      ['reasoning', 'reasoning'],
    ] as const) {
      const measured = count(tokens, [path])
      if (measured !== undefined) usage[field] = measured
    }
  } else {
    for (const field of [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'reasoning',
    ] as const) {
      const measured = count(value, semantics[field])
      if (measured !== undefined) usage[field] = measured
    }
  }
  return Object.keys(usage).length ? { counts: usage, opencode } : undefined
}

function finalizedUsage(
  entry: ProviderEntry,
  counts: BillingUsage | undefined,
  opencode: boolean,
): BillingUsage | undefined {
  if (!counts) return undefined
  const usage = { ...counts }
  if (opencode) {
    if (usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined)
      usage.cacheWrite = (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0)
    usage.reasoningIncludedInOutput = true
  } else {
    if (usage.input !== undefined && entry.billing?.promptIncludesCache)
      usage.input = Math.max(
        0,
        usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
      )
    if (entry.billing?.reasoningIncludedInOutput !== undefined)
      usage.reasoningIncludedInOutput = entry.billing.reasoningIncludedInOutput
  }
  return usage
}

/** Read only documented fields; absent counters must not become measured zeroes. */
export function billingUsage(
  entry: ProviderEntry,
  value: unknown,
): BillingUsage | undefined {
  const raw = rawBillingUsage(entry, value)
  return raw ? finalizedUsage(entry, raw.counts, raw.opencode) : undefined
}

/** The accessor can be installed or released after the plugin starts. */
export function hasBillingAccessor(): boolean {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

/** One receipt and one UUID for one physical send, including redirects and retries. */
export class BillingAttempt {
  private readonly attemptId = randomUUID()
  private reported = false
  private completed = false
  private failed = false
  private outputStarted = false
  private responseId?: string
  private rawUsage?: BillingUsage
  private rawOpenCodeUsage?: BillingUsage
  private status?: number
  private ended = false

  constructor(
    private readonly entry: ProviderEntry,
    private readonly provider: string,
    private readonly sessionId: string,
    private readonly requestKind: BillingRequestKind,
    private readonly model: string,
    private readonly receipt: ClaustrumScopedAttempt,
    private readonly attempt?: number,
    private readonly pi = false,
  ) {}

  event(value: unknown): void {
    if (!object(value)) return
    if (
      value.type === 'error' ||
      value.type === 'response.failed' ||
      value.error
    )
      this.failed = true
    if (
      value.type === 'response.completed' ||
      value.type === 'response.incomplete'
    )
      this.completed = true
    if (typeof value.type === 'string' && value.type.endsWith('.delta'))
      this.outputStarted = true
    if (Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        if (!object(choice)) continue
        if (choice.finish_reason != null) this.completed = true
        if (
          object(choice.delta) &&
          Object.keys(choice.delta).some((key) => key !== 'role')
        )
          this.outputStarted = true
        if (object(choice.message)) this.completed = true
      }
    }
    const response = object(value.response) ? value.response : value
    if (!this.pi && typeof response.id === 'string')
      this.responseId = response.id
    const raw = rawBillingUsage(this.entry, response)
    if (raw?.opencode) {
      // OpenCode's own input excludes cache already; do not mix it with
      // generic prompt totals, even if the namespaces arrive in different chunks.
      this.rawOpenCodeUsage = { ...this.rawOpenCodeUsage, ...raw.counts }
    } else if (raw) {
      this.rawUsage = { ...this.rawUsage, ...raw.counts }
    }
  }

  bodyEnd(ended: boolean, status: number): void {
    this.status = status
    this.ended = ended
    // Pi's stored responseId and stop reason arrive after its driver consumes
    // the successful body. Failed sends still settle before a retry starts.
    if (!this.pi || status < 200 || status >= 300) this.end()
  }

  cancel(status: number): void {
    // Hosts may stop reading at the protocol terminal marker without reading
    // byte EOF. Cancellation before that marker is still a cut response.
    this.bodyEnd(this.completed, status)
  }

  json(value: unknown): void {
    this.event(value)
    if (object(value) && !value.error) this.completed = true
  }

  done(): void {
    this.completed = true
  }

  piEnd(responseId?: string, stopReason?: string): void {
    // Use exactly the identifier Pi stores, not a competing wire identifier.
    this.responseId = responseId
    if (stopReason === 'error') this.failed = true
    if (stopReason === 'aborted') this.ended = false
    else if (stopReason && stopReason !== 'error') {
      this.completed = true
      this.ended = true
    }
    this.end()
  }

  end(
    outputStarted = this.outputStarted,
    ended = this.ended,
    status = this.status,
  ): void {
    if (this.reported) return
    this.reported = true
    const warming = sessionCachePolicy(this.sessionId)?.keep_warm
    const implicit = this.entry.billing?.implicitCache
    const usage = finalizedUsage(
      this.entry,
      this.rawOpenCodeUsage ?? this.rawUsage,
      this.rawOpenCodeUsage !== undefined,
    )
    reportRouting({
      sessionId: this.sessionId,
      kind: 'billing',
      attemptId: this.attemptId,
      requestKind: this.requestKind,
      credentialId: this.receipt.credentialId,
      ...(this.receipt.accountIdentity
        ? { accountId: this.receipt.accountIdentity }
        : {}),
      provider: this.provider,
      model: this.model,
      outcome:
        this.failed || (status !== undefined && (status < 200 || status >= 300))
          ? 'failed'
          : this.completed && ended
            ? 'completed'
            : outputStarted
              ? 'cut'
              : 'failed',
      ...(status !== undefined ? { status } : {}),
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
      ...(this.responseId ? { providerResponseId: this.responseId } : {}),
      ...(this.entry.chargeBasis
        ? { chargeBasis: this.entry.chargeBasis }
        : {}),
      ...(usage ? { usage } : {}),
      ...(implicit || (warming && warming !== 'off')
        ? {
            cache: {
              ...(implicit ? { implicit } : {}),
              ...(warming && warming !== 'off'
                ? { warming: { on: false, stopReason: 'unsupported' } }
                : {}),
            },
          }
        : {}),
    })
  }
}

/** Billing is strictly opt-in; do not even acquire a reader without an attempt. */
export function observeBillingResponse(
  record: BillingAttempt | undefined,
  response: Response,
): Response {
  if (!record) return response
  if (!response.body) {
    record.bodyEnd(true, response.status)
    return response
  }
  const sse = /^text\/event-stream(?:\s*;|$)/i.test(
    response.headers.get('content-type') ?? '',
  )
  const decoder = new TextDecoder()
  let json = ''
  let oversized = false
  const body = sse
    ? response.body.pipeThrough(
        watchServerSentEvents(
          (event) => {
            if (event.data === '[DONE]') record.done()
            else {
              try {
                record.event(JSON.parse(event.data))
              } catch {}
            }
          },
          () => {},
        ),
      )
    : response.body
  const reader = body.getReader()
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              if (!sse && !oversized) {
                try {
                  record.json(JSON.parse(json + decoder.decode()))
                } catch {}
              }
              record.bodyEnd(true, response.status)
              controller.close()
            } else {
              if (!sse && !oversized) {
                json += decoder.decode(next.value, { stream: true })
                // Accounting must not retain an unbounded non-streaming response.
                if (json.length > 1024 * 1024) {
                  oversized = true
                  json = ''
                }
              }
              controller.enqueue(next.value)
            }
          } catch (error) {
            record.bodyEnd(false, response.status)
            controller.error(error)
          }
        },
        cancel(reason) {
          record.cancel(response.status)
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}
