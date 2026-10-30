import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

function probe({
  host = '1.4.2',
  installed = '1.4.4',
  npmFails = false,
  fast = false,
} = {}) {
  const scratch = path.resolve('target/scratch/gate-tests')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(path.join(scratch, 'checkout with spaces-'))
  function executable(name: string, source: string) {
    const file = path.join(root, name)
    writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${source}\n`)
    chmodSync(file, 0o700)
  }
  function bun(version: string) {
    // Stop at the first real gate command so no build or host suite is mocked green.
    return `if [[ $1 == --version ]]; then printf '%s\\n' '${version}'; exit 0; fi
printf 'BUN_COMMAND ${version} %s\\n' "$*"
exit 42`
  }
  try {
    mkdirSync(path.join(root, 'scripts'))
    mkdirSync(path.join(root, 'bin'))
    writeFileSync(
      path.join(root, 'scripts/gate.sh'),
      readFileSync(new URL('../scripts/gate.sh', import.meta.url)),
    )
    writeFileSync(path.join(root, '.mise.toml'), '[tools]\nbun = "1.4.4"\n')
    executable('bin/git', "printf 'fixture-commit\\n'")
    executable('bin/uname', "printf 'Linux\\n'")
    executable('bin/bun', bun(host))
    executable('pinned-bun', bun(installed))
    executable(
      'bin/npm',
      `printf 'NPM_COMMAND %s\\n' "$*"
${
  npmFails
    ? "printf 'registry unavailable\\n' >&2; exit 23"
    : `[[ $1 == install && $2 == --prefix && $4 == --no-save && $5 == --package-lock=false && $6 == bun@1.4.4 ]]
[[ $3 == "$PWD/target/scratch/gate-tools" ]]
mkdir -p "$3/node_modules/.bin"
cp pinned-bun "$3/node_modules/.bin/bun"`
}`,
    )
    // Git for Windows' Bash launcher prepends its own tools to PATH, which
    // would hide these fakes. Put them first inside Bash, after it starts.
    const child = spawnSync(
      'bash',
      [
        '-c',
        'export PATH="$PWD/bin:$PATH"; exec bash scripts/gate.sh "$@"',
        'gate-fixture',
        ...(fast ? ['--fast'] : []),
      ],
      {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
        timeout: 5000,
      },
    )
    expect(child.error).toBeUndefined()
    return { status: child.status, output: child.stdout + child.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('full gate fetches the pin when PATH Bun differs and uses it for commands', () => {
  const result = probe()
  expect(result.output).toContain(
    'Bun on PATH is 1.4.2; fetching pinned Bun 1.4.4',
  )
  expect(result.output).toContain('NPM_COMMAND install --prefix ')
  expect(result.output).toContain('Using Bun 1.4.4 (')
  expect(result.output).toContain(
    '/target/scratch/gate-tools/node_modules/.bin/bun)',
  )
  expect(result.output).toContain('BUN_COMMAND 1.4.4 install --frozen-lockfile')
  expect(result.output).not.toContain('BUN_COMMAND 1.4.2')
  expect(result.status).toBe(42)
})

test('full gate reuses matching PATH Bun without npm', () => {
  const result = probe({ host: '1.4.4' })
  expect(result.output).toContain('Using Bun 1.4.4 (')
  expect(result.output).not.toContain('NPM_COMMAND')
  expect(result.output).toContain('BUN_COMMAND 1.4.4 install --frozen-lockfile')
  expect(result.status).toBe(42)
})

test('full gate refuses to continue when npm cannot obtain the pin', () => {
  const result = probe({ npmFails: true })
  expect(result.status).toBe(1)
  expect(result.output).toContain('registry unavailable')
  expect(result.output).toContain(
    'Cannot obtain pinned Bun 1.4.4: npm install failed',
  )
  expect(result.output).toContain('GATE_FAILED toolchain')
  expect(result.output).not.toContain('BUN_COMMAND')
})

test('full gate verifies the downloaded Bun instead of trusting npm success', () => {
  const result = probe({ installed: '1.4.3' })
  expect(result.status).toBe(1)
  expect(result.output).toContain(
    'Cannot use pinned Bun 1.4.4: selected Bun reports 1.4.3',
  )
  expect(result.output).toContain('GATE_FAILED toolchain')
  expect(result.output).not.toContain('BUN_COMMAND')
})

test('fast gate keeps the developer Bun without fetching or enforcing the pin', () => {
  const result = probe({ fast: true })
  expect(result.output).not.toContain('NPM_COMMAND')
  expect(result.output).not.toContain('Using Bun')
  expect(result.output).toContain('BUN_COMMAND 1.4.2 install --frozen-lockfile')
  expect(result.status).toBe(42)
})
