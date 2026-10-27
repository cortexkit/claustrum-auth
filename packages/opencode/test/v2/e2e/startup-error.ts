/** Error messages and native security fields are often non-enumerable. */
export function startupError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error)
  if (depth >= 5) return `${error.name}: ${error.message}`
  const details = Object.fromEntries(
    Object.getOwnPropertyNames(error)
      .filter((key) => key !== 'cause')
      .map((key) => [key, (error as unknown as Record<string, unknown>)[key]]),
  )
  return {
    name: error.name,
    ...details,
    ...(error.cause === undefined
      ? {}
      : { cause: startupError(error.cause, depth + 1) }),
  }
}
