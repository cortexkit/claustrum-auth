import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeConfig, describeHosts, describePlugin } from './diagnostics.ts'

test('failure diagnostics keep startup and every process across a restart', () => {
  const noise = 'request completed\n'.repeat(1000)
  const output = describeHosts([
    {
      name: 'host serve',
      stdout: ['first server startup\n', noise],
      stderr: ['plugin setup failed: private-files refusal\n', noise],
    },
    { name: 'login fixture-a', stdout: [], stderr: ['method not found'] },
    { name: 'host serve', stdout: ['second server startup'], stderr: [] },
  ])
  expect(output).toContain(`first server startup\n${noise}`)
  expect(output).toContain(
    `plugin setup failed: private-files refusal\n${noise}`,
  )
  expect(output).toContain('login fixture-a')
  expect(output).toContain('method not found')
  expect(output).toContain('second server startup')
})

test('failure diagnostics print the exact config and recursive plugin file list', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oc2-diagnostics-'))
  try {
    const config = '{\n  "plugins": ["file:///C:/RUNNER~1/plugin"]\n}\n'
    const file = path.join(root, 'opencode.json')
    writeFileSync(file, config)
    mkdirSync(path.join(root, 'plugin', 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'plugin', 'package.json'), '{}')
    writeFileSync(path.join(root, 'plugin', 'dist', 'index.js'), '')
    expect(describeConfig(file)).toContain(`\n${config}`)
    const listing = describePlugin(path.join(root, 'plugin'))
    expect(listing).toContain('package.json')
    expect(listing).toContain(path.join('dist', 'index.js'))
    expect(listing).toContain('realpath')
    expect(describePlugin(path.join(root, 'absent'))).toContain('ENOENT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
