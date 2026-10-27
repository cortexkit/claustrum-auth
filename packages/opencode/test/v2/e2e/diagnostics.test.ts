import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

test.each(['directory', 'junction'] as const)(
  'failure diagnostics list scoped dependencies and identify a node_modules %s',
  (layout) => {
    const root = mkdtempSync(path.join(tmpdir(), 'oc2-module-diagnostics-'))
    try {
      const plugin = path.join(root, 'plugin')
      mkdirSync(plugin)
      const modules =
        layout === 'directory'
          ? path.join(plugin, 'node_modules')
          : path.join(root, 'installed')
      const dependency = path.join(modules, '@cortexkit', 'claustrum-client')
      mkdirSync(dependency, { recursive: true })
      writeFileSync(path.join(dependency, 'not-a-recursive-module-dump.js'), '')
      if (layout === 'junction') {
        symlinkSync(modules, path.join(plugin, 'node_modules'), 'junction')
      }
      const listing = describePlugin(plugin)
      expect(listing).toContain('plugin node_modules listing and link types')
      expect(listing).toContain(
        JSON.stringify(path.join(plugin, 'node_modules')),
      )
      expect(listing).toContain(
        JSON.stringify(
          path.join(plugin, 'node_modules', '@cortexkit', 'claustrum-client'),
        ),
      )
      expect(listing).toContain(
        `"type":"${layout === 'directory' ? 'directory' : 'symbolic link (junction on Windows)'}"`,
      )
      if (layout === 'junction') expect(listing).toContain('"target":')
      expect(listing).not.toContain('not-a-recursive-module-dump.js')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

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
