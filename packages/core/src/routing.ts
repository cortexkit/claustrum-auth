import {
  askRouting,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import { isBalanceFailure } from './balance.js'
import { ClaustrumAuthError } from './placement.js'
import type { ServingConsumer } from './serving.js'

export const routingDeclinedText =
  'Thalamus routing declined this request, so it was not sent.'
export const routingNoAnswerText =
  'Thalamus routing did not answer, so this API key request was not sent.'

export function routingRefusalText(code: string): string | undefined {
  if (code === 'routing-declined') return routingDeclinedText
  if (code === 'routing-no-answer') return routingNoAnswerText
  return undefined
}

// Thalamus may install or release its bridge after the plugin starts.
export function hasVaultRoutingAccessor(): boolean {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

export interface RoutedKey {
  routeId: string
  accountId: string
  credentialId: string
}

export async function selectRoutedKey(
  consumer: ServingConsumer,
  provider: string,
  modelId: string,
  sessionId: string | undefined,
  excluded: ReadonlySet<string> = new Set(),
  nextRoute?: string,
): Promise<RoutedKey | undefined> {
  if (!hasVaultRoutingAccessor()) return undefined
  const routes = consumer.routingRows()
  const roster = consumer.snapshot?.()?.rows ?? []
  const next = nextRoute ?? routes.find((row) => !excluded.has(row.id))?.id
  // Subscription rows keep the plugin's existing order and retry behavior;
  // routing has not adopted those vault logins yet.
  if (roster.find((row) => row.routeId === next)?.credentialType === 'oauth')
    return undefined
  if (!sessionId) throw new ClaustrumAuthError('routing-no-answer')
  // routingRows applies the user's on/off switches. Snapshot supplies vault
  // identities, never the plugin's synthetic route id or a key version.
  const enabled = new Set(routes.map((row) => row.id))
  const candidates = roster
    .filter(
      (row) =>
        enabled.has(row.routeId) &&
        !excluded.has(row.routeId) &&
        row.credentialType === 'api_key',
    )
    .map((row) => ({
      routeId: row.routeId,
      credentialId: row.credentialId,
      accountId: row.accountIdentity ?? row.credentialId,
    }))
  const answer = await askRouting({
    sessionId,
    provider,
    modelId,
    candidates,
    refusals: true,
  })
  if (!answer) throw new ClaustrumAuthError('routing-no-answer')
  if ('refused' in answer) throw new ClaustrumAuthError('routing-declined')
  return answer.candidate
}

export async function reportRoutedBalance(
  key: RoutedKey | undefined,
  sessionId: string | undefined,
  service: string,
  status: number,
  body: () => Promise<string>,
): Promise<void> {
  if (!key || !sessionId || status !== 402) return
  const text = await body().catch(() => '')
  if (!isBalanceFailure(service, text)) return
  const providerCode =
    service === 'openrouter' ? 'openrouter_credits' : 'http_402'
  reportRouting({
    sessionId,
    accountId: key.accountId,
    credentialId: key.credentialId,
    outcome: 'credential_refused',
    providerCode,
  })
}

export function routedCompletion(
  key: RoutedKey | undefined,
  sessionId: string | undefined,
  response: Response,
): (() => void) | undefined {
  if (!key || !sessionId || !response.ok) return undefined
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (
      lower.startsWith('x-ratelimit-') ||
      lower.startsWith('ratelimit') ||
      lower.startsWith('anthropic-ratelimit-') ||
      lower === 'retry-after'
    )
      headers[lower] = value
  })
  return () =>
    reportRouting({
      sessionId,
      accountId: key.accountId,
      credentialId: key.credentialId,
      outcome: 'served',
      headers,
    })
}
