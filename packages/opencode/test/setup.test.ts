import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { row } from '../../core/test/fakes.ts'
import { createTestCore, fixtureEntries } from '../../core/test-entry.ts'
import { runClaustrumSetup, vaultOnlyMessage } from '../src/setup.ts'
import { resolveOpencodeStateDir } from '../src/state-dir.ts'
import { scratchRoot } from './scratch-root.ts'
import { setupIO, setupTestBuild } from './setup-harness.ts'

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
  expect(h.proposals).toEqual([])
  expect(existsSync(path.join(root, 'state'))).toBe(false)
  expect(existsSync(path.join(root, 'config'))).toBe(false)
  expect(existsSync(path.join(root, 'pi'))).toBe(false)
  expect(h.commands.every(({ args }) => args.includes('--version'))).toBe(true)
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
  expect(JSON.stringify(registration)).toContain(
    '@cortexkit/opencode-claustrum-auth@0.0.0',
  )
  expect(JSON.stringify(h.commands)).toContain(
    'npm:@cortexkit/pi-claustrum-auth@0.0.0',
  )
})

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
  expect(h.commands.every(({ args }) => args.includes('--version'))).toBe(true)
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

test('separated --host pi limits vault-only setup to Pi without a host prompt', async () => {
  const root = await profile()
  const h = setupIO(root)
  const result = await runClaustrumSetup(['--dry-run', '--host', 'pi'], h.io)
  expect(result?.hosts).toEqual(['pi'])
  expect(h.output()).toContain('Enrollment: claustrum-auth-pi')
  expect(h.output()).not.toContain('Enrollment: claustrum-auth-opencode')
  expect(h.output()).not.toContain('Would Connect opencode')
  expect(h.proposals).toEqual([])
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
  expect(help.stdout).toContain('Usage:')
  for (const flag of [
    '--dry-run',
    '--yes',
    '--host',
    '--opencode',
    '--enroll-only',
    '--claustrum',
    '--help',
  ])
    expect(help.stdout).toContain(flag)
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
