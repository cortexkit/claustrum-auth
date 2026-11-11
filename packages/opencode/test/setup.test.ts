import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  ClaustrumCredentialError,
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { row } from '../../core/test/fakes.ts'
import { installVaultHost } from '../../core/test/host.ts'
import { createTestCore, fixtureEntries } from '../../core/test-entry.ts'
import { runClaustrumSetup, vaultOnlyMessage } from '../src/setup.ts'
import { resolveOpencodeStateDir } from '../src/state-dir.ts'
import { scratchRoot } from './scratch-root.ts'
import { isVersionProbe, setupIO, setupTestBuild } from './setup-harness.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
async function profile() {
  await mkdir(scratchRoot(), { recursive: true })
  const dir = await mkdtemp(path.join(scratchRoot(), 'setup-'))
  dirs.push(dir)
  return dir
}

test('published setup dry run names both enrollments, exact grants and native activation instructions without fixtures or writes', async () => {
  const root = await profile()
  const h = setupIO(root)
  const bin = path.join(import.meta.dir, '..', 'dist', 'setup-bin.js')
  expect(existsSync(bin)).toBe(true)
  const built = (await import(bin)) as {
    runClaustrumSetup: typeof runClaustrumSetup
  }
  const result = await built.runClaustrumSetup(
    [
      '--dry-run',
      '--claustrum',
      '--host=opencode',
      '--host=pi',
      '--opencode=both',
    ],
    h.io,
  )
  expect(result?.hosts).toEqual(['opencode', 'pi'])
  const text = h.output()
  for (const host of ['opencode', 'pi']) {
    expect(text).toContain(`Enrollment: claustrum-auth-${host}`)
    expect(text).toContain(
      `ck auth grant --principal enrolled:claustrum-auth-${host} --selector-kind category --selector llm-provider --operation read`,
    )
  }
  // The shipped table names real providers, so the dry run prints one
  // activation line per host id, the OpenCode one for the first live provider.
  expect(text).toContain('opencode auth login cerebras --method claustrum-auth')
  expect(text).toContain(
    'opencode auth login fireworks-ai --method claustrum-auth',
  )
  expect(text).toContain('/claustrum use cerebras')
  expect(text).toContain('/claustrum use fireworks')
  expect(text).toContain('Pi asks consent')
  expect(text).not.toContain('no provider is available yet')
  expect(text).not.toMatch(/fixture-/u)
  expect(text).toContain(resolveOpencodeStateDir(h.env, root))
  expect(text).toContain(path.join(h.env.PI_CODING_AGENT_DIR, 'claustrum-auth'))
  expect(text).not.toMatch(/fixture-|vault-auth|\/vault\b|~/u)
  // Vault keys need no migration, so the plugin gives setup no migrate step.
  expect(text).not.toContain('Would migrate')
  expect(h.proposals).toEqual([])
  expect(existsSync(path.join(root, 'state'))).toBe(false)
  expect(existsSync(path.join(root, 'config'))).toBe(false)
  expect(existsSync(path.join(root, 'pi'))).toBe(false)
  expect(h.commands.length).toBeGreaterThan(0)
  expect(h.commands.every(isVersionProbe)).toBe(true)
  const node = Bun.which('node')
  expect(node).not.toBeNull()
  const cli = spawnSync(node as string, [bin, '--not-a-setup-flag'], {
    env: h.env,
    cwd: root,
    encoding: 'utf8',
  })
  expect(cli.status).toBe(1)
  expect(cli.stderr).toContain('Unknown setup argument: --not-a-setup-flag')
})

test('published setup dry run prints the exact OpenCode state override without changing Pi or writing files', async () => {
  const root = await profile()
  const stateDir = path.join(root, 'shared enrollment')
  const h = setupIO(root, {
    OPENCODE_CLAUSTRUM_AUTH_STATE_DIR: ` ${stateDir}\t`,
  })
  const bin = path.join(import.meta.dir, '..', 'dist', 'setup-bin.js')
  const built = (await import(bin)) as {
    runClaustrumSetup: typeof runClaustrumSetup
  }
  await built.runClaustrumSetup(['setup', '--dry-run', '--opencode=both'], h.io)
  expect(h.output()).toContain(stateDir)
  expect(h.output()).toContain(
    path.join(h.env.PI_CODING_AGENT_DIR, 'claustrum-auth'),
  )
  expect(h.output()).not.toContain(path.join(root, 'state', 'cortexkit'))
  expect(h.proposals).toEqual([])
  expect(existsSync(stateDir)).toBe(false)
  expect(existsSync(path.join(root, 'state'))).toBe(false)
  expect(existsSync(path.join(root, 'config'))).toBe(false)
  expect(existsSync(path.join(root, 'pi'))).toBe(false)
})

test.each([false, true])(
  'setup enrolls in the OpenCode state override (enroll-only: %j)',
  async (enrollOnly) => {
    const root = await profile()
    const stateDir = path.join(root, 'shared enrollment')
    const h = setupIO(root, {
      OPENCODE_CLAUSTRUM_AUTH_STATE_DIR: stateDir,
    })
    await (await setupTestBuild())(
      [
        'setup',
        '--yes',
        '--host=opencode',
        '--opencode=both',
        ...(enrollOnly ? ['--enroll-only'] : []),
      ],
      h.io,
      fixtureEntries,
      async () => ({
        async listScoped() {
          return { rows: [], view: 'empty', grants: 0, grantTuples: [] }
        },
        async getScoped() {
          throw new Error('setup must not read credential material')
        },
        async reportAuthFailureScoped() {},
        close() {},
      }),
    )
    expect(h.proposals).toEqual(['claustrum-auth-opencode'])
    expect(h.output()).toContain(stateDir)
    const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
    expect(await enrollmentAuthority(paths, 'claustrum-auth-opencode')).toBe(
      'vault',
    )
    expect(existsSync(path.join(stateDir, 'config-dir.json'))).toBe(false)
    expect(existsSync(path.join(root, 'state'))).toBe(false)
    expect(existsSync(path.join(root, 'pi', 'claustrum-auth'))).toBe(false)
  },
)

test.skipIf(process.platform === 'win32')(
  'setup tightens a 0755 OpenCode override to 0700 before enrollment and roster secrets are written',
  async () => {
    const root = await profile()
    const stateDir = path.join(root, 'shared enrollment')
    await mkdir(stateDir)
    await chmod(stateDir, 0o755)
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755)
    const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
    const h = setupIO(root, { OPENCODE_CLAUSTRUM_AUTH_STATE_DIR: stateDir })
    let proposed = false
    let polled = false
    h.io.connect = async () => ({
      async enrollPropose({ name }) {
        proposed = true
        expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
        expect(existsSync(paths.tokenPath)).toBe(false)
        expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
        return { requestId: name }
      },
      async enrollPoll({ requestId }) {
        polled = true
        expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
        expect(existsSync(paths.tokenPath)).toBe(false)
        return {
          status: 'approved',
          name: requestId,
          token: '01'.repeat(32),
          tokenGeneration: 1,
        }
      },
      close() {},
    })
    await runClaustrumSetup(
      ['setup', '--yes', '--enroll-only', '--host=opencode'],
      h.io,
    )
    expect(proposed).toBe(true)
    expect(polled).toBe(true)
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
    expect(await enrollmentAuthority(paths, 'claustrum-auth-opencode')).toBe(
      'vault',
    )
    const built = createTestCore({
      stateDir: resolveOpencodeStateDir(h.env, root),
      tokenPath: paths.tokenPath,
      isCustodyActive: async () =>
        (await enrollmentAuthority(paths, 'claustrum-auth-opencode')) ===
        'vault',
      facts: { host: 'opencode1', catalog: ['fixture-a'] },
      connect: async () => ({
        async listScoped() {
          expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
          expect(
            (await stat(path.dirname(built.hub.rosterPath('fixture-a')))).mode &
              0o777,
          ).toBe(0o700)
          return {
            rows: [row('a')],
            view: 'override',
            grants: 1,
            grantTuples: [],
          }
        },
        async getScoped() {
          throw new Error('discovery must not read credential material')
        },
        async reportAuthFailureScoped() {},
        close() {},
      }),
    })
    try {
      await built.hub.refresh()
      const rosterPath = built.hub.rosterPath('fixture-a')
      expect(built.consumers.get('fixture-a')?.routingRows()).toHaveLength(1)
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
      expect((await stat(path.dirname(rosterPath))).mode & 0o777).toBe(0o700)
      expect((await stat(rosterPath)).mode & 0o777).toBe(0o600)
    } finally {
      await built.hub.dispose()
    }
  },
)

test('test setup build enrolls once per host, discovers rows, prints provider activation and preserves host credentials', async () => {
  const root = await profile()
  const h = setupIO(root)
  const setup = await setupTestBuild()
  let lists = 0
  await setup(
    ['--yes', '--claustrum', '--opencode=both'],
    h.io,
    fixtureEntries,
    async () => ({
      async listScoped() {
        lists++
        return { rows: [row('a')], view: 'setup', grants: 0, grantTuples: [] }
      },
      async getScoped() {
        throw new Error('setup must not read credential material')
      },
      async reportAuthFailureScoped() {
        throw new Error('setup must not report credential failure')
      },
      close() {},
    }),
  )
  expect(h.proposals).toEqual(['claustrum-auth-opencode', 'claustrum-auth-pi'])
  expect(lists).toBe(3)
  const states = {
    opencode: resolveOpencodeStateDir(h.env, root),
    pi: path.join(h.env.PI_CODING_AGENT_DIR, 'claustrum-auth'),
  }
  for (const host of ['opencode', 'pi'] as const) {
    const paths = hostEnrollmentPaths({ stateDir: states[host], host })
    expect(await enrollmentAuthority(paths, `claustrum-auth-${host}`)).toBe(
      'vault',
    )
  }
  expect(h.output()).toContain('/claustrum use fixture-a')
  expect(h.output()).toContain(
    'opencode auth login fixture-a --method claustrum-auth',
  )
  expect(existsSync(path.join(root, 'data', 'opencode', 'auth.json'))).toBe(
    false,
  )
  expect(existsSync(path.join(root, 'pi', 'auth.json'))).toBe(false)
  const registration = JSON.parse(
    await readFile(
      path.join(root, 'config', 'opencode', 'opencode.jsonc'),
      'utf8',
    ),
  )
  // Setup registers the package's own version. Read it from the manifest so a
  // release's version bump doesn't fail this test.
  const { version } = JSON.parse(
    await readFile(path.join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  expect(JSON.stringify(registration)).toContain(
    `@cortexkit/opencode-claustrum-auth@${version}`,
  )
  expect(JSON.stringify(h.commands)).toContain(
    `npm:@cortexkit/pi-claustrum-auth@${version}`,
  )
})

test('setup proposes a person-facing display name and provider read grant for each vault host', async () => {
  const root = await profile()
  const h = setupIO(root)
  await runClaustrumSetup(
    ['setup', '--yes', '--enroll-only', '--host=opencode', '--host=pi'],
    h.io,
  )
  expect(h.proposalInputs).toEqual([
    {
      name: 'claustrum-auth-opencode',
      displayName: 'Model API keys for OpenCode',
      requestedGrants: [
        { selector: { category: 'llm-provider' }, operation: 'read' },
      ],
      requestSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
    {
      name: 'claustrum-auth-pi',
      displayName: 'Model API keys for Pi',
      requestedGrants: [
        { selector: { category: 'llm-provider' }, operation: 'read' },
      ],
      requestSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  ])
})

test.each(['reachable', 'no-logins', 'unconfirmed', 'older-vault'] as const)(
  'setup relies on enrollment access guidance without duplicate grant hints (%s)',
  async (access) => {
    const root = await profile()
    const h = setupIO(root)
    const connect = h.io.connect
    if (!connect) throw new Error('missing enrollment transport')
    let lists = 0
    h.io.connect = async (options) => {
      const client = await connect(options)
      return {
        ...client,
        async enrollPropose(input) {
          if (access === 'older-vault' && input.requestedGrants)
            throw new ClaustrumCredentialError(
              'invalid_params',
              'permanent',
              'gone',
            )
          return client.enrollPropose(input)
        },
        async listScoped() {
          lists++
          if (access === 'unconfirmed') throw new Error('vault unavailable')
          return {
            rows: access === 'reachable' ? [row('a')] : [],
            view: 'setup',
            grants: access === 'reachable' ? 1 : 0,
            grantTuples: [],
          }
        },
      }
    }
    await runClaustrumSetup(
      ['--yes', '--host=opencode', '--host=pi', '--opencode=both'],
      h.io,
      {
        table: fixtureEntries,
        createCore: (options) =>
          createTestCore({
            ...options,
            connect: async () => ({
              async listScoped() {
                return { rows: [], view: 'empty', grants: 0, grantTuples: [] }
              },
              async getScoped() {
                throw new Error('setup must not read credential material')
              },
              async reportAuthFailureScoped() {},
              close() {},
            }),
          }),
      },
    )
    expect(lists).toBe(access === 'older-vault' ? 0 : 2)
    const text = h.output()
    if (access === 'reachable') {
      expect(text).toContain('Confirmed read access')
      expect(text).not.toContain('ck auth grant ')
    } else {
      expect(text).toContain(
        access === 'older-vault'
          ? 'This vault is too old to grant access with the approval'
          : access === 'no-logins'
            ? 'Approved, but no logins are reachable yet'
            : 'Approved, but access could not be confirmed',
      )
      for (const host of ['opencode', 'pi'])
        expect(text).toContain(
          `ck auth grant --principal enrolled:claustrum-auth-${host} --selector-kind category --selector llm-provider --operation read`,
        )
      expect(text.match(/ck auth grant /gu)).toHaveLength(2)
    }
    expect(text).not.toContain('Grant command:')
    expect(text).toContain('/claustrum use fixture-a')
    expect(text).toContain(
      'opencode auth login fixture-a --method claustrum-auth',
    )
  },
)

test.each([false, true])(
  'setup confirms access on an already approved enrollment (without stored grants: %j)',
  async (withoutStoredGrants) => {
    const root = await profile()
    const h = setupIO(root)
    const args = ['--yes', '--enroll-only', '--host=opencode', '--host=pi']
    await runClaustrumSetup(args, h.io)
    if (withoutStoredGrants) {
      const states = {
        opencode: resolveOpencodeStateDir(h.env, root),
        pi: path.join(h.env.PI_CODING_AGENT_DIR, 'claustrum-auth'),
      }
      for (const host of ['opencode', 'pi'] as const) {
        const { statePath } = hostEnrollmentPaths({
          stateDir: states[host],
          host,
        })
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        delete state.requestedGrants
        delete state.requestedGrantsStatus
        await writeFile(statePath, JSON.stringify(state))
      }
    }
    const connect = h.io.connect
    if (!connect) throw new Error('missing enrollment transport')
    let lists = 0
    h.io.connect = async (options) => ({
      ...(await connect(options)),
      async listScoped() {
        lists++
        return { rows: [row('a')], view: 'setup', grants: 1, grantTuples: [] }
      },
    })
    const start = h.output().length
    await runClaustrumSetup(args, h.io)
    expect(lists).toBe(2)
    expect(h.proposals).toEqual([
      'claustrum-auth-opencode',
      'claustrum-auth-pi',
    ])
    const text = h.output().slice(start)
    expect(text.match(/Already connected as /gu)).toHaveLength(2)
    expect(text.match(/Confirmed read access /gu)).toHaveLength(2)
    expect(text).not.toContain('ck auth grant ')
  },
)

test('setup refuses local sign-in and delegates enroll-only without host registration or credential reads', async () => {
  const root = await profile()
  const h = setupIO(root)
  await expect(
    runClaustrumSetup(['--yes', '--no-claustrum', '--host=opencode'], h.io),
  ).rejects.toThrow(vaultOnlyMessage)
  expect(h.proposals).toEqual([])
  const result = await runClaustrumSetup(
    ['--yes', '--enroll-only', '--host', 'pi'],
    h.io,
  )
  expect(result?.hosts).toEqual(['pi'])
  expect(h.proposals).toEqual(['claustrum-auth-pi'])
  expect(h.commands.length).toBeGreaterThan(0)
  expect(h.commands.every(isVersionProbe)).toBe(true)
  expect(
    existsSync(path.join(root, 'config', 'opencode', 'opencode.json')),
  ).toBe(false)
})

test('setup explains grants reaching no usable credentials instead of presenting enrollment as access', async () => {
  const root = await profile()
  const h = setupIO(root)
  await runClaustrumSetup(
    ['--yes', '--claustrum', '--host=opencode', '--opencode=1'],
    h.io,
    {
      table: fixtureEntries,
      createCore: (options) =>
        createTestCore({
          ...options,
          connect: async () => ({
            async listScoped() {
              return { rows: [], view: 'empty', grants: 1, grantTuples: [] }
            },
            async getScoped() {
              throw new Error('no read')
            },
            async reportAuthFailureScoped() {},
            close() {},
          }),
        }),
    },
  )
  expect(h.output()).toContain('The grant reaches no usable credentials')
  expect(h.output()).toContain('provider ids this plugin does not serve')
  expect(h.output()).not.toContain('Grant command:')
})

test('grant guidance uses the approved enrollment name when the operator renames it', async () => {
  const root = await profile()
  const h = setupIO(root)
  h.io.connect = async () => ({
    async enrollPropose() {
      return { requestId: 'rename' }
    },
    async enrollPoll() {
      return {
        status: 'approved',
        name: 'renamed-claustrum-plugin',
        token: '01'.repeat(32),
        tokenGeneration: 1,
      }
    },
    close() {},
  })
  await runClaustrumSetup(
    ['--yes', '--claustrum', '--host=opencode', '--opencode=1'],
    h.io,
  )
  expect(h.output()).toContain('--principal enrolled:renamed-claustrum-plugin')
  expect(h.output()).not.toContain(
    '--principal enrolled:claustrum-auth-opencode',
  )
})

test('shared stopped-process fence refuses setup before enrollment or state binding', async () => {
  const root = await profile()
  const h = setupIO(root)
  h.io.fence = {
    async listRunningHosts() {
      return [{ pid: 42, command: 'opencode' }]
    },
  }
  await expect(
    runClaustrumSetup(['--yes', '--claustrum', '--host=opencode'], h.io),
  ).rejects.toThrow()
  expect(h.proposals).toEqual([])
  expect(existsSync(path.join(root, 'state'))).toBe(false)
})

test('no-flag setup dry run defaults to vault enrollment, grants and activation without local sign-in', async () => {
  const root = await profile()
  const h = setupIO(root)
  const bin = path.join(import.meta.dir, '..', 'dist', 'setup-bin.js')
  const built = (await import(bin)) as {
    runClaustrumSetup: typeof runClaustrumSetup
  }
  const result = await built.runClaustrumSetup(['--dry-run'], h.io)
  expect(result?.mode).toBe('claustrum')
  expect(result?.hosts).toEqual(['opencode', 'pi'])
  expect(h.output()).toContain('Enrollment: claustrum-auth-opencode')
  expect(h.output()).toContain('Enrollment: claustrum-auth-pi')
  expect(h.output()).toContain(
    'ck auth grant --principal enrolled:claustrum-auth-pi',
  )
  expect(h.output()).toContain('/claustrum use cerebras')
  expect(h.output()).not.toContain('/claustrum use <provider>')
  expect(h.output()).not.toMatch(
    /sign in locally|beforeSignIn\([^\n]*local\)|\(local\)/u,
  )
  expect(h.proposals).toEqual([])
  expect(existsSync(path.join(root, 'state'))).toBe(false)
})

test('explicit --no-claustrum is refused with the fixed vault-only message before planning', async () => {
  const root = await profile()
  const h = setupIO(root)
  await expect(
    runClaustrumSetup(['--dry-run', '--no-claustrum'], h.io),
  ).rejects.toThrow('This plugin serves vault keys only.')
  expect(h.output()).toBe('')
  expect(h.proposals).toEqual([])
  expect(h.commands).toEqual([])
})

test.each([
  ['separated', ['--host', 'pi']],
  ['equals', ['--host=pi']],
] as const)(
  '%s --host pi limits vault-only setup to Pi without a host prompt',
  async (_form, host) => {
    const root = await profile()
    const h = setupIO(root)
    const result = await runClaustrumSetup(['--dry-run', ...host], h.io)
    expect(result?.hosts).toEqual(['pi'])
    expect(h.output()).toContain('Enrollment: claustrum-auth-pi')
    expect(h.output()).not.toContain('Enrollment: claustrum-auth-opencode')
    expect(h.output()).not.toContain('Would Connect opencode')
    expect(h.output()).toContain('Would Connect pi')
    expect(h.proposals).toEqual([])
  },
)

test('a leading setup argument reaches the same plan as the bare flag form', async () => {
  const root = await profile()
  const bare = setupIO(root)
  const bareResult = await runClaustrumSetup(['--dry-run'], bare.io)
  const sub = setupIO(root)
  const subResult = await runClaustrumSetup(['setup', '--dry-run'], sub.io)
  expect(subResult?.dryRun).toBe(true)
  expect(subResult?.hosts).toEqual(bareResult?.hosts ?? [])
  expect(sub.output()).toContain('Enrollment: claustrum-auth-opencode')
  expect(sub.output()).toBe(bare.output())
  expect(sub.proposals).toEqual([])
  expect(existsSync(path.join(root, 'state'))).toBe(false)
})

test('built setup bin --help prints supported flags and exits successfully without setup', async () => {
  const root = await profile()
  const h = setupIO(root)
  await runClaustrumSetup(['--help'], h.io)
  expect(h.output()).toContain('Usage:')
  expect(h.commands).toEqual([])
  expect(h.proposals).toEqual([])
  const bin = path.join(import.meta.dir, '..', 'dist', 'setup-bin.js')
  const node = Bun.which('node')
  expect(node).not.toBeNull()
  const help = spawnSync(node as string, [bin, '--help'], {
    env: h.env,
    cwd: root,
    encoding: 'utf8',
  })
  expect(help.status).toBe(0)
  expect(help.stdout).toContain(
    'Usage: npx @cortexkit/opencode-claustrum-auth setup [flags]',
  )
  // The shared flag list, including its space form for --host.
  for (const flag of [
    '--dry-run',
    '--yes',
    '--host opencode|pi',
    '--opencode=1|2|both',
    '--enroll-only',
    '--claustrum',
    '--help',
  ])
    expect(help.stdout).toContain(flag)
  expect(help.stdout).toContain('Flags:')
  // Vault is the only mode, so the local sign-in flags are not advertised.
  expect(help.stdout).not.toContain('--no-claustrum')
  expect(help.stdout).not.toContain('--login')
  const subcommand = spawnSync(node as string, [bin, 'setup', '--help'], {
    env: h.env,
    cwd: root,
    encoding: 'utf8',
  })
  expect(subcommand.status).toBe(0)
  expect(subcommand.stdout).toBe(help.stdout)
  expect(help.stdout).not.toContain('Checking that OpenCode')
  expect(help.stderr).toBe('')
  expect(existsSync(path.join(root, 'state'))).toBe(false)
})

test.each(['detected', 'explicit'] as const)(
  'OpenCode 2 activation instruction is printed when generation is %s',
  async (generation) => {
    const root = await profile()
    const h = setupIO(root)
    if (generation === 'detected') {
      const fs = h.io.fs
      if (!fs) throw new Error('missing setup detection filesystem')
      h.io.fs = {
        ...fs,
        readText: (file) =>
          file === path.join(root, 'bin with spaces', 'package.json')
            ? JSON.stringify({ name: '@opencode/cli', version: '2.0.32' })
            : fs.readText(file),
      }
    }
    await runClaustrumSetup(
      ['--dry-run', ...(generation === 'explicit' ? ['--opencode=2'] : [])],
      h.io,
    )
    // The published dry run names the first live provider of the shipped table
    // and the placeholder form for the rest.
    expect(h.output()).toContain(
      'opencode auth login cerebras --method claustrum-auth',
    )
    expect(h.output()).not.toContain(
      'opencode auth login <provider> --method claustrum-auth',
    )
    expect(h.output()).not.toContain('In OpenCode 1, type next:')
  },
)

test('hosted setup refuses with the shared sentence before detection or any change on every host', async () => {
  installVaultHost()
  const io = new Proxy(
    {},
    {
      get() {
        throw new Error('setup touched detection or IO')
      },
    },
  )
  for (const host of ['opencode', 'pi'])
    await expect(runClaustrumSetup([`--host=${host}`], io)).rejects.toThrow(
      "This host gets its vault accounts from Thalamus, so it can't connect to the vault itself.",
    )
})
