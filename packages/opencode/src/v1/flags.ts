import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'

// The persisted `released` flag per provider. A released provider is never
// re-entered by anything automatic; only `/claustrum use` clears the flag.
export class ReleasedFlags {
  readonly #file: string
  #queue: Promise<unknown> = Promise.resolve()

  constructor(stateDir: string) {
    this.#file = path.join(stateDir, 'opencode1-activation.json')
  }

  async read(): Promise<Set<string>> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw error
    }
    const value = JSON.parse(text) as { released?: unknown }
    return new Set(
      Array.isArray(value.released)
        ? value.released.filter((id): id is string => typeof id === 'string')
        : [],
    )
  }

  async isReleased(provider: string): Promise<boolean> {
    return (await this.read()).has(provider)
  }

  // Writes are serialized in this process; the file is written atomically
  // through common-auth, which keeps it owner-only on every OS.
  set(provider: string, released: boolean): Promise<void> {
    const run = this.#queue.then(async () => {
      const current = await this.read()
      if (released) current.add(provider)
      else current.delete(provider)
      await writeJsonAtomic(this.#file, { released: [...current].sort() })
    })
    this.#queue = run.catch(() => undefined)
    return run
  }
}
