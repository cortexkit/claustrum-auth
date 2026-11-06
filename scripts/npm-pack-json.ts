/**
 * The package records `npm pack --json` printed. Up to npm 11 it prints an
 * array of records; from npm 12 an object keyed by package name. The records
 * themselves (`name`, `filename`, `files[].path`) have the same fields in both.
 */
export function packedRecords<T = Record<string, any>>(parsed: unknown): T[] {
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed !== null && typeof parsed === 'object')
    return Object.values(parsed) as T[]
  return []
}
