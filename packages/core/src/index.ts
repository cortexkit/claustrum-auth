export const pluginId = 'cortexkit.claustrum-auth'
export const command = '/claustrum'
export const opencodeEnrollment = 'claustrum-auth-opencode'
export const piEnrollment = 'claustrum-auth-pi'
export type {
  ActivationEffect,
  ActivationEvent,
  ActivationState,
} from './activation.js'
export {
  initialActivation,
  SlotQueue,
  transitionActivation,
} from './activation.js'
export type { CoreFetch, FetchOptions } from './fetch.js'
export { createFetch, maxBodyBytes } from './fetch.js'
export {
  ClaustrumAuthError,
  checkOrigin,
  checkPlacement,
  redactError,
  redactResponse,
} from './placement.js'
export type {
  Host,
  HostFacts,
  ProviderClass,
  ProviderEntry,
  RefusalCode,
} from './providers.js'
export {
  classifyingFamily,
  classifyRow,
  refusalCodes,
  reservedProviders,
  supportedProviders,
} from './providers.js'
export type { CoreOptions } from './runtime.js'
export { createCore } from './runtime.js'
export type { ServingConsumer, ServingOptions } from './serving.js'
export { orderedRoutes, servingCallbacks } from './serving.js'
