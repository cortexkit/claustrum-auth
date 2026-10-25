import type { Refusal } from './placement.js'
import type { Host } from './providers.js'

export interface ActivationState {
  host: Host
  status: 'unlisted' | 'available' | 'owned'
  consented: boolean
  released: boolean
  vaultOn: boolean
  routable: boolean
  automatic: boolean
  pending?: 'enter' | 'exit'
}
export type ActivationEffect =
  | 'register-available'
  | 'register-owned'
  | 'enter-slot'
  | 'exit-slot'
  | 'refresh-registry'
  | 'persist-flags'
export type ActivationEvent =
  | { type: 'start'; listed: boolean; placeholder: boolean; vaultOn: boolean }
  | { type: 'discovery'; routable: boolean }
  | { type: 'authority'; vaultOn: boolean }
  | {
      type: 'activate'
      vaultOn: boolean
      routable: boolean
      effectiveKey?: boolean
      consented?: boolean
    }
  | { type: 'release' }
  | { type: 'entered'; success: boolean; wrote: boolean }
  | { type: 'exited'; success: boolean }

export interface ActivationTransition {
  state: ActivationState
  effects: ActivationEffect[]
  refusal?: Refusal
}

export function initialActivation(
  host: Host,
  flags: { consented?: boolean; released?: boolean } = {},
): ActivationState {
  return {
    host,
    status: 'unlisted',
    consented: flags.consented ?? false,
    released: flags.released ?? false,
    vaultOn: false,
    routable: false,
    automatic: false,
  }
}

// Slot operations are effects, so adapters can keep storage and registration in
// this order without coupling the transition table to a particular host API.
export function transitionActivation(
  previous: ActivationState,
  event: ActivationEvent,
): ActivationTransition {
  const state = { ...previous }
  const effects: ActivationEffect[] = []
  const result: ActivationTransition = { state, effects }
  const enter = () => {
    state.automatic = false
    state.status = 'owned'
    state.pending = 'enter'
    if (state.host === 'pi') effects.push('register-owned')
    effects.push('enter-slot')
  }
  const exit = () => {
    state.pending = 'exit'
    effects.push('exit-slot')
  }
  switch (event.type) {
    case 'start':
      state.status = !event.listed
        ? 'unlisted'
        : event.placeholder
          ? 'owned'
          : 'available'
      state.vaultOn = event.vaultOn
      state.automatic = state.host === 'pi' && event.vaultOn
      if (event.listed)
        effects.push(
          event.placeholder ? 'register-owned' : 'register-available',
        )
      if (state.host === 'pi' && !event.vaultOn && state.status === 'owned')
        exit()
      break
    case 'authority':
      if (!event.vaultOn) state.automatic = false
      else if (!state.vaultOn) state.automatic = state.host === 'pi'
      state.vaultOn = event.vaultOn
      if (!event.vaultOn) {
        state.routable = false
        if (state.host === 'pi' && state.status === 'owned' && !state.pending)
          exit()
      }
      break
    case 'discovery':
      state.routable = event.routable
      break
    case 'activate':
      if (state.status === 'unlisted' || !event.routable)
        result.refusal = 'no-vault-account'
      else if (!event.vaultOn) result.refusal = 'vault-mode-off'
      else if (state.host === 'pi' && !(event.consented ?? state.consented))
        result.refusal = 'consent-required'
      else if (state.host === 'opencode1' && event.effectiveKey)
        result.refusal = 'credential-shadowed'
      if (result.refusal || state.pending) return { ...result, state: previous }
      state.vaultOn = event.vaultOn
      state.routable = event.routable
      state.consented = event.consented ?? state.consented
      state.released = false
      effects.push('persist-flags')
      if (state.status !== 'owned') enter()
      break
    case 'release':
      state.released = true
      state.automatic = false
      effects.push('persist-flags')
      if (state.status === 'owned' && !state.pending) exit()
      break
    case 'entered':
      if (state.pending !== 'enter') return result
      state.pending = undefined
      if (!event.success && !event.wrote) {
        state.status = 'available'
        effects.push('register-available')
      }
      effects.push('refresh-registry')
      if (
        state.status === 'owned' &&
        (state.released || (state.host === 'pi' && !state.vaultOn))
      )
        exit()
      break
    case 'exited':
      if (state.pending !== 'exit') return result
      state.pending = undefined
      if (event.success) {
        state.status = 'available'
        effects.push('register-available', 'refresh-registry')
      }
      break
  }
  if (
    state.host === 'pi' &&
    state.automatic &&
    state.vaultOn &&
    state.routable &&
    state.consented &&
    !state.released &&
    state.status === 'available' &&
    !state.pending
  ) {
    state.automatic = false
    enter()
  }
  return result
}

// One queue is shared by all Pi providers, not one queue per slot.
export class SlotQueue {
  #tail: Promise<unknown> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.catch(() => undefined)
    return result
  }
}
