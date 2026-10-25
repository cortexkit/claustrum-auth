import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function assertPackageContents(files, label) {
  const names = files.map((file) =>
    typeof file === 'string' ? file : file.path,
  )
  const forbidden = names.filter(
    (name) =>
      /(?:test-entry|\.test\.|\.spec\.|(?:^|\/)tests?(?:\/|$))/u.test(name) ||
      !/^(?:dist\/[^/]+\.(?:js|d\.ts)|package\.json|README(?:\.md)?|LICENSE(?:\.md)?)$/u.test(
        name,
      ),
  )
  if (forbidden.length)
    throw new Error(
      `${label}: unexpected published files: ${forbidden.join(', ')}`,
    )
  if (!names.includes('dist/index.js'))
    throw new Error(`${label}: missing built entry`)
}

export function checkPackageContents(root = process.cwd()) {
  for (const name of ['opencode', 'pi']) {
    const cwd = path.join(root, 'packages', name)
    const output = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    )
    const [pack] = JSON.parse(output)
    assertPackageContents(pack.files, name)
    console.log(
      `${pack.name}: npm pack --dry-run checked ${pack.files.length} files; tests and test entry absent.`,
    )
  }
}

if (import.meta.main) checkPackageContents()
