import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The folder every OpenCode test makes its scratch folders in.
 *
 * common-auth writes owner-only files and refuses a parent folder that other
 * users may change. A Windows CI checkout (D:\a\...) is such a folder, so on
 * Windows the scratch goes in the user's own temp folder instead. That folder
 * is often given by its 8.3 short name (C:\Users\RUNNER~1\...); the tests
 * use its full name so the paths they compare and print are the ones Windows
 * reports for files that exist.
 */
export function scratchRoot(): string {
  return process.platform === 'win32'
    ? path.join(realpathSync.native(os.tmpdir()), 'claustrum-auth-scratch')
    : path.join(import.meta.dir, '..', '..', '..', 'target', 'scratch')
}
