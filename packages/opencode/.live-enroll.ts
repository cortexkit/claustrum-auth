// Operator live smoke only (not committed): enrolls one claustrum-auth host
// with the real vault through common-auth's own enrollment manager, as setup
// does, but without setup's machine-wide process fence, which refuses while
// the operator's own OpenCode runs. It writes no host configuration: only the
// enrollment files under the scratch profile given by LIVE_HOME.
import {
  ClaustrumEnrollmentManager,
  connectClaustrumEnrollmentClient,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'

const home = process.env.LIVE_HOME
const connectionFile = process.env.CLAUSTRUM_SUBC_CONNECTION
const host = process.argv[2]
if (!home || !connectionFile || (host !== 'opencode' && host !== 'pi'))
  throw new Error(
    'usage: LIVE_HOME=… CLAUSTRUM_SUBC_CONNECTION=… bun .live-enroll.ts opencode|pi',
  )

const name = host === 'opencode' ? 'claustrum-auth-opencode' : 'claustrum-auth-pi'
const stateDir =
  host === 'opencode'
    ? `${home}/.local/state/cortexkit/claustrum-auth/opencode`
    : `${home}/.pi/agent/claustrum-auth`
const client = await connectClaustrumEnrollmentClient({
  connectionFile,
  handshakeTimeoutMs: 2000,
})
const manager = new ClaustrumEnrollmentManager({
  client,
  paths: hostEnrollmentPaths({ stateDir, host }),
  proposedName: name,
})
let printed: string | undefined
const deadline = Date.now() + 60 * 60_000
for (;;) {
  const status = await manager.reconcile()
  if (status.state === 'approved') {
    console.log(`APPROVED ${name}`)
    process.exit(0)
  }
  if (status.state === 'pending' && status.requestId) {
    if (status.requestId !== printed) {
      printed = status.requestId
      console.log(
        `APPROVE: ck auth enroll approve --request-id ${status.requestId} --name ${name}`,
      )
    }
  } else if (status.state !== 'pending' && status.state !== 'busy') {
    console.log(`STOPPED ${name}: ${JSON.stringify(status)}`)
    process.exit(1)
  }
  if (Date.now() > deadline) {
    console.log(`TIMEOUT ${name}`)
    process.exit(1)
  }
  await new Promise((done) => setTimeout(done, 2000))
}
