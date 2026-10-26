import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'

export interface ProviderFlags {
  consented: boolean
  released: boolean
}

// The persisted `consented` and `released` flags per Pi provider.
export class FlagStore {
  #file: string
  #flags = new Map<string, ProviderFlags>()

  constructor(readonly stateDir: string) {
    this.#file = path.join(stateDir, 'pi-activation.json')
  }

  async load() {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch {
      return
    }
    try {
      const data = JSON.parse(text) as {
        version?: unknown
        providers?: Record<string, Partial<ProviderFlags>>
      }
      if (data.version !== 1 || typeof data.providers !== 'object') return
      for (const [provider, flags] of Object.entries(data.providers ?? {}))
        this.#flags.set(provider, {
          consented: flags.consented === true,
          released: flags.released === true,
        })
    } catch {
      // A damaged file grants nothing: no consent, no release.
    }
  }

  get(provider: string): ProviderFlags {
    return this.#flags.get(provider) ?? { consented: false, released: false }
  }

  async set(provider: string, flags: ProviderFlags) {
    this.#flags.set(provider, { ...flags })
    // Setup creates the state folder owner-only when it enrolls this host. The
    // flags only matter once a provider has been used through the vault, which
    // needs that enrollment, so they stay in memory until the folder exists
    // rather than letting this write create it with default permissions.
    if (!existsSync(this.stateDir)) return
    await writeJsonAtomic(this.#file, {
      version: 1,
      providers: Object.fromEntries(this.#flags),
    })
  }
}
