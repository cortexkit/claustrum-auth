import { expect, onTestFinished, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

test('shared fixtures restore routing and nested vault relays across test files', async () => {
  const scratch = path.join(import.meta.dir, '../../../target/scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'fixture-isolation-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const billing = JSON.stringify(
    new URL('./billing-fixtures.ts', import.meta.url).href,
  )
  const host = JSON.stringify(new URL('./host.ts', import.meta.url).href)
  const environment = JSON.stringify(new URL('./env.ts', import.meta.url).href)
  const source = `
import { expect, test } from 'bun:test'
import { captureBilling } from ${billing}
import { installVaultHost } from ${host}
import { setTestEnv } from ${environment}
test('install shared helpers more than once', () => {
  captureBilling()
  captureBilling()
  installVaultHost()
  installVaultHost()
  setTestEnv('PI_CODING_AGENT_DIR', 'first-test-profile')
  setTestEnv('PI_CODING_AGENT_DIR', 'second-test-profile')
})
test('ambient state is restored after the test', () => {
  expect({
    routing: Reflect.get(globalThis, Symbol.for('cortexkit.routing')),
    vault: Reflect.get(globalThis, Symbol.for('cortexkit.vault')),
    host: process.env.CORTEXKIT_VAULT_HOST,
    profile: process.env.PI_CODING_AGENT_DIR,
  }).toEqual({ routing: undefined, vault: undefined, host: undefined, profile: undefined })
})
`
  // Both files import the same cached helper. A module-level afterEach would
  // clean up only the first file, and per-install relay cleanup would retain
  // the earlier relay's hosted-mode marker after nested installations.
  const files = ['first.test.ts', 'second.test.ts'].map((name) =>
    path.join(dir, name),
  )
  await Promise.all(files.map((file) => writeFile(file, source)))
  const env = { ...process.env }
  delete env.CORTEXKIT_VAULT_HOST
  delete env.CLAUSTRUM_AUTH_E2E_ROUTING
  delete env.PI_CODING_AGENT_DIR
  const child = Bun.spawnSync([process.execPath, 'test', ...files], {
    cwd: dir,
    env,
  })
  const output = Buffer.concat([child.stdout, child.stderr]).toString()
  expect({ exit: child.exitCode, output }).toMatchObject({
    exit: 0,
    output: expect.stringContaining('4 pass'),
  })
})
