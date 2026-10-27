import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import { hostEnrollmentPaths } from '@cortexkit/common-auth/claustrum'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
import {
  opencodeConfigDir,
  opencodeStateDir,
  resolveOpencodeStateDir,
} from '../src/state-dir.ts'
import { ReleasedFlags } from '../src/v1/flags.ts'
import { productionDeps } from '../src/v2/vault.ts'
import { scratchRoot } from './scratch-root.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true })
})

async function profile() {
  const scratch = scratchRoot()
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(path.join(scratch, 'opencode-state-'))
  cleanup.push(root)
  return {
    root,
    home: path.join(root, 'home'),
    env: { XDG_STATE_HOME: path.join(root, 'state') },
  }
}

test('the default config uses the home-based opencode key and the same state default on every OS', async () => {
  const { home, env } = await profile()
  const configDir = path.join(home, '.config', 'opencode')
  expect(opencodeConfigDir({}, home)).toBe(configDir)
  const dir = await opencodeStateDir({}, home)
  expect(dir).toBe(
    path.join(
      home,
      '.local',
      'state',
      'cortexkit',
      'claustrum-auth',
      'opencode',
    ),
  )
  expect(await opencodeStateDir(env, home)).toBe(
    path.join(env.XDG_STATE_HOME, 'cortexkit', 'claustrum-auth', 'opencode'),
  )
  expect(
    JSON.parse(await readFile(path.join(dir, 'config-dir.json'), 'utf8')),
  ).toEqual({
    version: 1,
    configDir,
  })
  expect(await stat(configDir).catch(() => undefined)).toBeUndefined()
})

test('a custom OPENCODE_CONFIG_DIR hashes its native identity and binds an owner-only manifest once', async () => {
  const { root, home, env } = await profile()
  const configDir = path.join(root, 'custom-config')
  await mkdir(configDir)
  const identity = realpathSync.native(configDir)
  const key = `opencode-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
  const options = { ...env, OPENCODE_CONFIG_DIR: configDir }
  const dir = await opencodeStateDir(options, home)
  expect(dir).toBe(
    path.join(env.XDG_STATE_HOME, 'cortexkit', 'claustrum-auth', key),
  )
  const manifest = path.join(dir, 'config-dir.json')
  expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual({
    version: 1,
    configDir: identity,
  })
  const timestamp = new Date('2000-01-01T00:00:00Z')
  await utimes(manifest, timestamp, timestamp)
  const before = await stat(manifest)
  await opencodeStateDir(options, home)
  expect((await stat(manifest)).mtimeMs).toBe(before.mtimeMs)
  if (process.platform !== 'win32') {
    expect(before.mode & 0o777).toBe(0o600)
  }
  expect(await readdir(configDir)).toEqual([])
})

test('different XDG_CONFIG_HOME paths to the same real config folder share a key', async () => {
  const { root, home, env } = await profile()
  const real = path.join(root, 'real-xdg')
  const alias = path.join(root, 'alias-xdg')
  await mkdir(path.join(real, 'opencode'), { recursive: true })
  await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const first = await opencodeStateDir({ ...env, XDG_CONFIG_HOME: real }, home)
  const second = await opencodeStateDir(
    { ...env, XDG_CONFIG_HOME: alias },
    home,
  )
  const explicit = await opencodeStateDir(
    { ...env, OPENCODE_CONFIG_DIR: path.join(alias, 'opencode') },
    home,
  )
  expect(first).toBe(second)
  expect(explicit).toBe(first)
  expect(path.basename(first)).toMatch(/^opencode-[0-9a-f]{16}$/)
})

test('a config folder created later under an aliased parent keeps the state folder setup bound', async () => {
  const { root, home, env } = await profile()
  const real = path.join(root, 'real-xdg')
  const alias = path.join(root, 'alias-xdg')
  await mkdir(real)
  await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const options = { ...env, XDG_CONFIG_HOME: alias }
  // Setup runs before OpenCode has created its config folder.
  const preview = resolveOpencodeStateDir(options, home)
  const bound = await opencodeStateDir(options, home)
  expect(bound).toBe(preview)
  await mkdir(path.join(alias, 'opencode'))
  // The host starts once the folder exists and must find the same state.
  expect(resolveOpencodeStateDir(options, home)).toBe(bound)
  expect(await opencodeStateDir(options, home)).toBe(bound)
  expect(
    JSON.parse(await readFile(path.join(bound, 'config-dir.json'), 'utf8')),
  ).toEqual({
    version: 1,
    configDir: realpathSync.native(path.join(real, 'opencode')),
  })
})

test('an XDG_CONFIG_HOME alias of the home config folder still uses the default key', async () => {
  const { root, home, env } = await profile()
  const configHome = path.join(home, '.config')
  const configDir = path.join(configHome, 'opencode')
  const alias = path.join(root, 'xdg-alias')
  await mkdir(configDir, { recursive: true })
  await symlink(
    configHome,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const dir = await opencodeStateDir({ ...env, XDG_CONFIG_HOME: alias }, home)
  expect(path.basename(dir)).toBe('opencode')
  expect(await opencodeStateDir(env, home)).toBe(dir)
  expect(
    JSON.parse(await readFile(path.join(dir, 'config-dir.json'), 'utf8')),
  ).toEqual({
    version: 1,
    configDir: realpathSync.native(configDir),
  })
})

test('two different config folders have different keys, even before they exist', async () => {
  const { root, home, env } = await profile()
  const configDir = path.join(root, 'not-created', 'Config')
  const first = await opencodeStateDir(
    { ...env, OPENCODE_CONFIG_DIR: configDir },
    home,
  )
  const second = await opencodeStateDir(
    { ...env, OPENCODE_CONFIG_DIR: path.join(root, 'other') },
    home,
  )
  expect(first).not.toBe(second)
  expect(path.basename(first)).toBe(
    `opencode-${createHash('sha256').update(configDir).digest('hex').slice(0, 16)}`,
  )
  expect(
    JSON.parse(await readFile(path.join(first, 'config-dir.json'), 'utf8'))
      .configDir,
  ).toBe(configDir)
  expect(await stat(configDir).catch(() => undefined)).toBeUndefined()
})

test('a foreign config-dir.json refuses with fixed text and is never replaced', async () => {
  const { home, env } = await profile()
  const dir = await opencodeStateDir(env, home)
  const manifest = path.join(dir, 'config-dir.json')
  const foreign = { version: 1, configDir: 'foreign-config-identity' }
  await writeJsonAtomic(manifest, foreign)
  const refusal = await opencodeStateDir(env, home).catch(
    (error: Error) => error.message,
  )
  expect(refusal).toBe(
    'claustrum-auth: state directory belongs to a different OpenCode config directory.',
  )
  expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual(foreign)
})

test('the OpenCode 2 runtime shares enrollment and writes nothing under the config folder', async () => {
  const { root, home, env } = await profile()
  const configDir = path.join(root, 'config')
  await mkdir(configDir)
  const options = { ...env, OPENCODE_CONFIG_DIR: configDir }
  const runtime = await productionDeps(options)
  const key = `opencode-${createHash('sha256').update(realpathSync.native(configDir)).digest('hex').slice(0, 16)}`
  const expected = path.join(
    env.XDG_STATE_HOME,
    'cortexkit',
    'claustrum-auth',
    key,
  )
  expect(await readdir(expected)).toEqual(['config-dir.json'])
  const stateDir = await opencodeStateDir(options, home)
  const paths = hostEnrollmentPaths({ stateDir, host: 'opencode' })
  await writeJsonAtomic(paths.tokenPath, {
    token: '01'.repeat(32),
    token_generation: 1,
  })
  await writeJsonAtomic(paths.statePath, {
    version: 1,
    phase: 'approved',
    proposedName: 'claustrum-auth-opencode',
    tokenGeneration: 1,
    updatedAt: 0,
  })
  expect(await runtime.authority()).toBe('vault')
  await new ReleasedFlags(stateDir).set('fixture-a', true)
  expect(await readFile(paths.tokenPath, 'utf8')).toContain('01'.repeat(32))
  expect(await new ReleasedFlags(stateDir).isReleased('fixture-a')).toBe(true)
  expect(await readdir(configDir)).toEqual([])
})
