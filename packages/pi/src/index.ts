import { createCore } from '@cortexkit/claustrum-auth-core'
import { createPiExtension } from './extension.js'

/** The claustrum-auth Pi extension, serving the published provider table. */
export default createPiExtension({ createCore })
