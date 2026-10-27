import os from 'node:os'
import path from 'node:path'

/**
 * The folder every OpenCode test makes its scratch folders in.
 *
 * common-auth writes owner-only files and refuses a parent folder that other
 * users may change. A Windows CI checkout (D:\a\...) is such a folder, so on
 * Windows the scratch goes in the user's own temp folder instead.
 */
export function scratchRoot(): string {
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claustrum-auth-scratch')
    : path.join(import.meta.dir, '..', '..', '..', 'target', 'scratch')
}
