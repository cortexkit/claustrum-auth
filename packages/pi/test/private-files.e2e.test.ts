// The files the Pi extension keeps under <agentDir>/claustrum-auth after a
// real enrollment: the setup test build enrolls a clean profile, real Pi
// activates a provider from the fake vault and serves a request, and then
// every file and folder there must be owner-only. On POSIX that is mode 0600
// for files and 0700 for folders; on Windows it is a protected ACL that only
// the current user (and the system) can open, read by @cortexkit/private-files.
//
// On Windows CI a second, standard user also tries to read them (see
// test/windows/ and the pi-windows-private-files job in ci.yml): the probe can
// list the agent folder and read a file placed there for it, and is refused
// the plugin's folder and every file in it.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { verifyOwnerOnly } from '@cortexkit/private-files'
import { fixtureEntries } from '../../core/test-entry.ts'
import { setupIO, setupTestBuild } from '../../opencode/test/setup-harness.ts'
import { anyFileContains, e2e, row, secretOf } from './harness.ts'
import { world } from './scenario.ts'

setDefaultTimeout(120_000)

// Set by the Windows job that provisions the probe user; the second-user
// check then must run, and fails if the probe account is missing.
const secondUser = process.env.CLAUSTRUM_AUTH_PI_SECOND_USER === '1'

/** Every file and folder below `dir`, folders first. */
function tree(dir: string): { files: string[]; folders: string[] } {
  const files: string[] = []
  const folders: string[] = [dir]
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const below = tree(child)
      folders.push(...below.folders)
      files.push(...below.files)
    } else files.push(child)
  }
  return { files, folders }
}

/**
 * Enroll a clean Pi profile through setup, activate fixture-a, reorder its
 * accounts and serve one request, so the token, the enrollment state, the
 * activation flags, the login stash and the vault roster have all been
 * written. Pi is stopped before returning, so nothing is mid-write.
 */
async function enrolledProfile() {
  const { mock, vault, agent, launch } = await world({
    enrolled: false,
    rows: [row('first', 'fixture-a'), row('second', 'fixture-a')],
  })
  const paths = hostEnrollmentPaths({ stateDir: agent.state, host: 'pi' })
  expect(existsSync(agent.state)).toBe(false)
  const h = setupIO(agent.home, { PI_CODING_AGENT_DIR: agent.agent })
  await (await setupTestBuild())(
    ['--yes', '--claustrum', '--host=pi'],
    h.io,
    fixtureEntries,
    async () => ({
      listScoped: async () =>
        (await fetch(`${vault.url}/list`, { method: 'POST' })).json(),
      async getScoped() {
        throw new Error('setup cannot read keys')
      },
      async reportAuthFailureScoped() {},
      close() {},
    }),
  )
  expect(h.proposals).toEqual(['claustrum-auth-pi'])
  expect(await enrollmentAuthority(paths, 'claustrum-auth-pi')).toBe('vault')
  const pi = await launch()
  expect(await pi.slash('/claustrum use fixture-a')).toContain(
    'fixture-a now uses keys from the Claustrum vault',
  )
  const ids = [
    ...(await pi.slash('/claustrum accounts')).matchAll(/\[(vault:[^\]]+)\]/gu),
  ].map((match) => match[1])
  expect(ids).toHaveLength(2)
  expect(
    await pi.slash(`/claustrum reorder fixture-a ${ids[1]} ${ids[0]}`),
  ).toContain('order reordered')
  expect(await pi.turn('fixture-a', 'ok')).toMatchObject({
    text: 'served-ok',
    error: '',
  })
  expect(mock.seen.map((request) => request.headers.authorization)).toEqual([
    `Bearer ${secretOf('second')}`,
  ])
  await pi.stop()
  const { files, folders } = tree(agent.state)
  const names = files.map((file) =>
    path.relative(agent.state, file).replaceAll('\\', '/'),
  )
  // The token, its ceremony state, the activation flags, the stashed login
  // and the vault roster the reorder wrote.
  expect(names).toEqual(
    expect.arrayContaining([
      path.basename(paths.tokenPath),
      path.basename(paths.statePath),
      'pi-activation.json',
      'pi-slots/fixture-a.json',
    ]),
  )
  expect(
    names.some((name) => /^rosters\/pi\/[^/]+\/fixture-a\.json$/u.test(name)),
  ).toBe(true)
  return { agent, files, folders, names }
}

async function expectOwnerOnly(paths: string[]) {
  const results = await Promise.all(
    paths.map(async (file) => ({ file, result: await verifyOwnerOnly(file) })),
  )
  expect(results.filter(({ result }) => !result.ok)).toEqual([])
}

describe.skipIf(!e2e)('Pi extension private files on the real host', () => {
  test('after a real enrollment and a served request, every file and folder under claustrum-auth is owner-only', async () => {
    const { agent, files, folders, names } = await enrolledProfile()
    console.log(`claustrum-auth files: ${JSON.stringify(names)}`)
    await expectOwnerOnly([...folders, ...files])
    expect(anyFileContains(agent.home, secretOf('second'))).toEqual([])
  })

  test.skipIf(!secondUser)(
    'a standard second user can read the agent folder but not the claustrum-auth folder or any file in it',
    async () => {
      expect(process.platform).toBe('win32')
      const { agent, files, folders } = await enrolledProfile()
      await expectOwnerOnly([...folders, ...files])
      // Long, resolved names: the probe user may not list the folders above
      // the profile's temp folder, so it must not need to expand a short
      // (8.3) name such as RUNNER~1 on the way down.
      const real = (file: string) => realpathSync.native(file)
      const result = await deny({
        controlDir: real(agent.agent),
        directory: real(agent.state),
        paths: files.map(real),
      })
      console.log(`second-user probe: ${JSON.stringify(result)}`)
      expect(result).toMatchObject({
        sid: process.env.CLAUSTRUM_AUTH_PROBE_SID,
        standardUser: true,
        publicRead: true,
        controlRead: true,
        controlListed: true,
        filesDenied: true,
        directoryDenied: true,
        fileCount: files.length,
      })
      // Granting the probe access to the agent folder did not reach into the
      // plugin's protected folder.
      await expectOwnerOnly([...folders, ...files])
    },
  )
})

/**
 * Run test/windows/deny.ps1 in Windows PowerShell 5.1, which starts the
 * second-user probe as the provisioned standard user and returns its result.
 */
async function deny(request: {
  controlDir: string
  directory: string
  paths: string[]
}) {
  // pwsh's module paths do not work in Windows PowerShell 5.1; let the child
  // rebuild its own.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== 'PSMODULEPATH',
    ),
  )
  const child = spawn(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(import.meta.dir, 'windows', 'deny.ps1'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    stdout += data
  })
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderr += data
  })
  child.stdin.end(JSON.stringify(request))
  const code = await new Promise<number | null>((resolve) =>
    child.on('exit', resolve),
  )
  if (code !== 0)
    throw new Error(`second-user probe failed (${code}):\n${stdout}\n${stderr}`)
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<
    string,
    unknown
  >
}
