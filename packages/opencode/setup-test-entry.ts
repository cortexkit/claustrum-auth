// This entry is never published. It gives setup tests the same fixture-only
// classification seam as the host test entries, without enabling it in the bin.
import type { ProviderEntry } from '../core/src/providers.ts'
import { createCoreWithTable } from '../core/src/runtime.ts'
import type { ClaustrumScopedClient } from '@cortexkit/common-auth/claustrum'
import type { SetupIO } from '@cortexkit/common-auth/setup'
import { runClaustrumSetup } from './src/setup.ts'

export function runFixtureSetup(
  argv: string[],
  io: SetupIO,
  table: readonly ProviderEntry[],
  connect: () => Promise<ClaustrumScopedClient>,
) {
  return runClaustrumSetup(argv, io, {
    table,
    createCore: (options) => createCoreWithTable({ ...options, connect }, table),
  })
}
