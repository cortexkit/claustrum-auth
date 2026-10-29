import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

test('Bun discovery prunes generated target tests before loading them', () => {
  const base = path.resolve('target/scratch/discovery')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(path.join(base, 'profile-'))
  try {
    writeFileSync(
      path.join(root, 'bunfig.toml'),
      readFileSync(new URL('../bunfig.toml', import.meta.url)),
    )
    mkdirSync(path.join(root, 'test'))
    mkdirSync(path.join(root, 'target/scratch'), { recursive: true })
    writeFileSync(
      path.join(root, 'test/discovery-probe.test.ts'),
      "import { test, expect } from 'bun:test'; test('authored source', () => expect(true).toBe(true))\n",
    )
    writeFileSync(
      path.join(root, 'target/scratch/discovery-probe.test.ts'),
      "throw new Error('generated target artifact was loaded')\n",
    )
    // An exact ./ path would bypass repository discovery and could pass even
    // without the ignore rule. A bare filter exercises the directory pruning.
    const child = spawnSync(process.execPath, ['test', 'discovery-probe'], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 3000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    const output = child.stdout + child.stderr
    expect(output).toContain('1 pass')
    expect(output).not.toContain('generated target artifact was loaded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
