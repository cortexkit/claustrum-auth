import { afterEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  ghCliFetcher,
  requiredCiJobs,
  verifyReleaseCi,
} from '../scripts/verify-release-ci.mjs'
import { syncVersion, validateVersion } from '../scripts/version-sync.mjs'

const root = path.resolve(import.meta.dir, '..')
const scratch = path.join(root, 'target', 'scratch')
const fixtures: string[] = []
function fixture() {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(path.join(scratch, 'release-'))
  fixtures.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of fixtures.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function put(
  directory: string,
  name: string,
  content: string,
  executable = false,
) {
  const filename = path.join(directory, name)
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, content)
  if (executable) chmodSync(filename, 0o755)
}

function versionFixture() {
  const directory = fixture()
  for (const name of ['opencode', 'pi', 'core'])
    put(
      directory,
      `packages/${name}/package.json`,
      `${JSON.stringify({ name, version: '0.0.0', private: name === 'core' }, null, 2)}\n`,
    )
  put(
    directory,
    'README.md',
    'npx @cortexkit/opencode-claustrum-auth@0.0.0 setup\n',
  )
  put(
    directory,
    'docs/nested/install.md',
    'pi install npm:@cortexkit/pi-claustrum-auth@0.0.0\n',
  )
  return directory
}

test('version sync updates both public packages and documentation, not private core', () => {
  const directory = versionFixture()
  expect(() => syncVersion('0.1.0', { directory, check: true })).toThrow(
    'Tag/version mismatch',
  )
  expect(syncVersion('0.1.0', { directory })).toBe(4)
  for (const name of ['opencode', 'pi'])
    expect(
      JSON.parse(
        readFileSync(
          path.join(directory, 'packages', name, 'package.json'),
          'utf8',
        ),
      ).version,
    ).toBe('0.1.0')
  expect(readFileSync(path.join(directory, 'README.md'), 'utf8')).toContain(
    '@0.1.0 setup',
  )
  expect(
    readFileSync(path.join(directory, 'docs/nested/install.md'), 'utf8'),
  ).toContain('@0.1.0\n')
  expect(
    JSON.parse(
      readFileSync(path.join(directory, 'packages/core/package.json'), 'utf8'),
    ).version,
  ).toBe('0.0.0')
  expect(syncVersion('0.1.0', { directory, check: true })).toBe(0)
})

test('versions accept semver identifiers and reject flags and malformed versions', () => {
  for (const version of ['0.1.0', '1.2.3-rc.1', '1.2.3-beta-test+build.4'])
    expect(() => validateVersion(version)).not.toThrow()
  for (const version of [
    '--dry',
    'v0.1.0',
    '01.2.3',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3\n',
    '1.2.3;echo bad',
  ])
    expect(() => validateVersion(version)).toThrow('Invalid semver')
})

const sha = 'a'.repeat(40)
function run(overrides = {}) {
  return {
    id: 10,
    run_number: 10,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}
const jobs = () =>
  requiredCiJobs.map((name) => ({ name, conclusion: 'success' }))
function api(responses: unknown[]) {
  let calls = 0
  return {
    count: () => calls,
    fetchImpl: async () => {
      const response = responses[calls++]
      if (response === undefined) throw new Error('Unexpected API request')
      if (typeof response === 'number')
        return new Response('', { status: response })
      if (response instanceof Error) throw response
      return Response.json(response)
    },
  }
}
function verifyOptions() {
  let elapsed = 0
  return {
    sha,
    token: 'test-token',
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms
    },
    timeoutMs: 60_000,
  }
}

test('release CI requires all real CI matrix entries', () => {
  const ci = Bun.YAML.parse(
    readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
  ) as { jobs: Record<string, { strategy: { matrix: { os: string[] } } }> }
  const expected = Object.entries(ci.jobs).flatMap(([name, job]) =>
    job.strategy.matrix.os.map((os) => `${name} (${os})`),
  )
  expect(requiredCiJobs.toSorted()).toEqual(expected.toSorted())
  expect(requiredCiJobs).toHaveLength(17)
})

test('release CI accepts only successful main push runs on exact SHA', async () => {
  const client = api([{ workflow_runs: [run()] }, { jobs: jobs() }])
  await verifyReleaseCi({ ...verifyOptions(), fetchImpl: client.fetchImpl })
  expect(client.count()).toBe(2)
  for (const overrides of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { status: 'in_progress' },
  ]) {
    const client = api([{ workflow_runs: [run(overrides)] }])
    await expect(
      verifyReleaseCi({ ...verifyOptions(), fetchImpl: client.fetchImpl }),
    ).rejects.toThrow('CI has not passed on exact HEAD')
    expect(client.count()).toBe(1)
  }
})

test('release CI refuses failed reruns and missing or skipped required jobs', async () => {
  const client = api([
    {
      workflow_runs: [
        run(),
        run({ id: 11, run_number: 11, conclusion: 'failure' }),
      ],
    },
  ])
  await expect(
    verifyReleaseCi({
      ...verifyOptions(),
      fetchImpl: client.fetchImpl,
      wait: true,
    }),
  ).rejects.toThrow('concluded failure')
  for (const entries of [
    jobs().slice(1),
    jobs().map((job, i) => (i ? job : { ...job, conclusion: 'skipped' })),
  ]) {
    const client = api([{ workflow_runs: [run()] }, { jobs: entries }])
    await expect(
      verifyReleaseCi({ ...verifyOptions(), fetchImpl: client.fetchImpl }),
    ).rejects.toThrow('Required CI jobs missing or unsuccessful')
  }
})

test('release CI retries transient failures in both API requests', async () => {
  const client = api([
    503,
    { workflow_runs: [run()] },
    502,
    { workflow_runs: [run()] },
    { jobs: jobs() },
  ])
  await verifyReleaseCi({ ...verifyOptions(), fetchImpl: client.fetchImpl })
  expect(client.count()).toBe(5)
  for (const error of [429, new Error('connection reset')]) {
    const client = api([error, { workflow_runs: [run()] }, { jobs: jobs() }])
    await verifyReleaseCi({ ...verifyOptions(), fetchImpl: client.fetchImpl })
    expect(client.count()).toBe(3)
  }
})

test('release CI fails immediately on 401 and 404, including job requests', async () => {
  for (const status of [401, 404]) {
    for (const responses of [[status], [{ workflow_runs: [run()] }, status]]) {
      const client = api(responses)
      await expect(
        verifyReleaseCi({
          ...verifyOptions(),
          fetchImpl: client.fetchImpl,
          wait: true,
        }),
      ).rejects.toThrow(`HTTP ${status}`)
      expect(client.count()).toBe(responses.length)
    }
  }
})

test('local release CI reads through the gh CLI, never by extracting its token', async () => {
  const calls: string[][] = []
  const gh =
    (output: string, fail = false) =>
    (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (fail) throw Object.assign(new Error('exit 1'), { stdout: output })
      return output
    }
  // verifyReleaseCi calls its fetchImpl as (url, init); the reader must take
  // that shape and ignore init (a regression passed init as the gh runner).
  const ok = await ghCliFetcher(
    gh('HTTP/2.0 200 OK\r\nX-Test: 1\r\n\r\n{"total_count":0}'),
  )(
    'https://api.github.com/repos/cortexkit/claustrum-auth/actions/runs?head_sha=abc',
    { headers: { Authorization: 'Bearer gh-cli' } },
  )
  expect(calls).toEqual([
    [
      'gh',
      'api',
      '--include',
      '/repos/cortexkit/claustrum-auth/actions/runs?head_sha=abc',
    ],
  ])
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ total_count: 0 })
  const missing = await ghCliFetcher(
    gh('HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}', true),
  )('https://api.github.com/repos/x/y', {})
  expect([missing.ok, missing.status]).toEqual([false, 404])
  // A refused or absent gh has no status line and must fail, not retry.
  const refused = await ghCliFetcher(gh('', true))(
    'https://api.github.com/repos/x/y',
    {},
  )
  expect([refused.ok, refused.status]).toEqual([false, 0])
  await expect(
    verifyReleaseCi({
      ...verifyOptions(),
      fetchImpl: ghCliFetcher(gh('', true)),
      wait: true,
    }),
  ).rejects.toThrow('HTTP 0')
  expect(
    readFileSync(
      path.join(import.meta.dir, '../scripts/verify-release-ci.mjs'),
      'utf8',
    ),
  ).not.toContain("'auth', 'token'")
})

test('release CI waits for the bump commit and times out rather than publishing without CI', async () => {
  const client = api([
    { workflow_runs: [] },
    { workflow_runs: [run()] },
    { jobs: jobs() },
  ])
  await verifyReleaseCi({
    ...verifyOptions(),
    fetchImpl: client.fetchImpl,
    wait: true,
  })
  const pending = api([{ workflow_runs: [] }])
  await expect(
    verifyReleaseCi({
      ...verifyOptions(),
      timeoutMs: 1,
      fetchImpl: pending.fetchImpl,
      wait: true,
    }),
  ).rejects.toThrow('Timed out')
})

function releaseFixture() {
  const directory = versionFixture()
  mkdirSync(path.join(directory, 'scripts'), { recursive: true })
  for (const name of ['release.sh', 'version-sync.mjs'])
    copyFileSync(
      path.join(root, 'scripts', name),
      path.join(directory, 'scripts', name),
    )
  const realNode = execFileSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  }).trim()
  put(
    directory,
    'bin/node',
    `#!/usr/bin/env bash
if [[ $1 == scripts/verify-release-ci.mjs ]]; then
  echo ci >> "$TRACE"
  [[ $CI_STATE != failed ]]
else
  exec ${JSON.stringify(realNode)} "$@"
fi
`,
    true,
  )
  put(
    directory,
    'bin/git',
    `#!/usr/bin/env bash
echo "git $*" >> "$TRACE"
case "$1 $2" in
  'status --porcelain') echo -n "$DIRTY" ;;
  'branch --show-current') echo "$BRANCH" ;;
  'rev-parse HEAD') printf '%040d\\n' 1 ;;
  'rev-parse refs/remotes/origin/main') printf '%040d\\n' "$REMOTE_HEAD" ;;
  'show-ref --verify') [[ $TAG_EXISTS == yes ]] ;;
  'diff --cached') exit 1 ;;
esac
`,
    true,
  )
  put(
    directory,
    'bin/bun',
    '#!/usr/bin/env bash\necho "bun $*" >> "$TRACE"\n',
    true,
  )
  put(
    directory,
    'scripts/gate.sh',
    '#!/usr/bin/env bash\necho "gate $*" >> "$TRACE"\n[[ $GATE_STATE != failed ]]\n',
    true,
  )
  const trace = path.join(directory, 'trace')
  writeFileSync(trace, '')
  return {
    directory,
    trace: () => readFileSync(trace, 'utf8'),
    execute: (args: string[], env = {}) =>
      // Git for Windows' Bash launcher prepends its own Git to PATH. Put the
      // fixture shims first inside Bash, after the launcher has initialized it.
      spawnSync(
        'bash',
        [
          '-c',
          'export PATH="$PWD/bin:$PATH"; exec bash scripts/release.sh "$@"',
          'release-fixture',
          ...args,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            TRACE: trace,
            BRANCH: 'main',
            REMOTE_HEAD: '1',
            ...env,
          },
        },
      ),
  }
}

test('release fixture keeps its shims ahead of commands added by Bash startup', () => {
  const fixture = releaseFixture()
  put(
    fixture.directory,
    'startup-bin/git',
    '#!/usr/bin/env bash\necho "Unexpected startup Git" >&2\nexit 97\n',
    true,
  )
  put(
    fixture.directory,
    'bash-startup.sh',
    // Model the native launcher adding Git before Bash runs the requested command.
    'export PATH="$PWD/startup-bin:$PATH"\nunset BASH_ENV\necho "shell startup" >> "$TRACE"\n',
  )
  const result = fixture.execute(['0.1.0', '--dry'], {
    BASH_ENV: path.join(fixture.directory, 'bash-startup.sh'),
  })
  expect(fixture.trace()).toStartWith('shell startup\n')
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(fixture.trace()).toContain(
    'ci\nbun install --lockfile-only\ngate --fast',
  )
  expect(fixture.trace()).not.toMatch(/git (add|commit|tag|push)/u)
})

test('release refuses misspelled preview flags and every extra argument before doing anything', () => {
  const fixture = releaseFixture()
  for (const args of [
    [],
    ['0.1.0', '--dry-run'],
    ['0.1.0', ''],
    ['0.1.0', '--dry', 'extra'],
    ['--dry'],
  ]) {
    const result = fixture.execute(args)
    expect(result.status).not.toBe(0)
    expect(fixture.trace()).toBe('')
  }
})

test('release refuses dirty, non-main, out-of-sync, existing-tag and failed-CI states before version edits', () => {
  for (const env of [
    { DIRTY: ' M README.md' },
    { BRANCH: 'feature' },
    { REMOTE_HEAD: '2' },
    { TAG_EXISTS: 'yes' },
    { CI_STATE: 'failed' },
  ]) {
    const fixture = releaseFixture()
    expect(fixture.execute(['0.1.0', '--dry'], env).status).not.toBe(0)
    expect(
      readFileSync(
        path.join(fixture.directory, 'packages/opencode/package.json'),
        'utf8',
      ),
    ).toContain('0.0.0')
    expect(fixture.trace()).not.toContain('gate')
    expect(fixture.trace()).not.toMatch(/git (commit|tag|push)/u)
  }
})

test('release dry preview runs version sync, lock refresh and fast gate without commit, tag or push', () => {
  const fixture = releaseFixture()
  const result = fixture.execute(['0.1.0', '--dry'])
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(
    readFileSync(
      path.join(fixture.directory, 'packages/opencode/package.json'),
      'utf8',
    ),
  ).toContain('0.1.0')
  expect(fixture.trace()).toContain(
    'ci\nbun install --lockfile-only\ngate --fast',
  )
  expect(fixture.trace()).not.toMatch(/git (add|commit|tag|push)/u)
  expect(result.stdout).toContain('[DRY] Would commit release: v0.1.0')
})

test('release commits, tags and atomically pushes only after the fast gate', () => {
  const fixture = releaseFixture()
  expect(fixture.execute(['0.1.0']).status).toBe(0)
  expect(fixture.trace()).toMatch(
    /gate --fast\ngit add -- .*\ngit diff --cached --quiet\ngit commit -m release: v0.1.0\ngit tag -a v0.1.0 -m Release v0.1.0\ngit push --atomic origin main refs\/tags\/v0.1.0/u,
  )
  const failed = releaseFixture()
  expect(failed.execute(['0.1.0'], { GATE_STATE: 'failed' }).status).not.toBe(0)
  expect(failed.trace()).not.toMatch(/git (add|commit|tag|push)/u)
})

test('release workflow uses exact CI, committed versions, OIDC and pinned actions without upgrading npm', () => {
  const source = readFileSync(
    path.join(root, '.github/workflows/release.yaml'),
    'utf8',
  )
  expect(source).toContain(`TARGET_SHA: \${{ github.sha }}`)
  expect(source).toContain('node scripts/verify-release-ci.mjs --wait')
  expect(source).toContain(
    `node scripts/version-sync.mjs "\${RELEASE_TAG#v}" --check`,
  )
  expect(source).toContain(
    'npm publish --workspace "$workspace" --provenance --access public',
  )
  expect(source).toContain('id-token: write')
  expect(source).not.toMatch(/secrets\.|npm (install|i) -g/u)
  for (const [, ref] of source.matchAll(/uses: [^@]+@(\S+)/gu))
    expect(ref).toMatch(/^[a-f0-9]{40}$/u)
})
