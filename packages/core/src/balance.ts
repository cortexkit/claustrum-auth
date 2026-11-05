// Retry after five minutes to detect a top-up without an hourly exclusion.
export const balanceProbeMs = 5 * 60 * 1000

// DeepSeek documents no body field and gives 402 only one meaning:
// "Insufficient Balance" ("You have run out of balance").
// https://api-docs.deepseek.com/quick_start/error_codes
// OpenRouter documents error.metadata.limit_source = "openrouter_credits"
// for account credits, but reason = "weight_exceeds_budget" is a request
// size limit, not an empty balance. Key and in-flight caps must not reroute.
// https://openrouter.ai/docs/api-reference/limits#handling-402-errors
export function isBalanceFailure(service: string | undefined, body?: string) {
  if (service === 'deepseek') return true
  if (service !== 'openrouter') return false
  try {
    const value: unknown = JSON.parse(body ?? '')
    if (typeof value !== 'object' || value === null || !('error' in value))
      return false
    const error = value.error
    if (typeof error !== 'object' || error === null || !('metadata' in error))
      return false
    const metadata = error.metadata
    return (
      typeof metadata === 'object' &&
      metadata !== null &&
      'limit_source' in metadata &&
      metadata.limit_source === 'openrouter_credits' &&
      (!('reason' in metadata) || metadata.reason !== 'weight_exceeds_budget')
    )
  } catch {
    return false
  }
}
