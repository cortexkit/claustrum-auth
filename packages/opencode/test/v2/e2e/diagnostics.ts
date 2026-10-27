import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { HostProcess } from './host.ts'

function failure(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
}

/** Keep both spellings visible when a Windows short path resolves elsewhere. */
export function describePath(file: string) {
  try {
    return { path: file, realpath: realpathSync.native(file) }
  } catch (error) {
    return { path: file, error: failure(error) }
  }
}

export function describeConfig(file: string) {
  try {
    return `--- opencode.json ${JSON.stringify(describePath(file))}\n${readFileSync(file, 'utf8')}`
  } catch (error) {
    return `--- opencode.json ${file}\n${failure(error)}`
  }
}

export function describePlugin(dir: string) {
  const files: string[] = []
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      files.push(path.relative(dir, file) + (entry.isDirectory() ? '/' : ''))
      if (entry.isDirectory()) visit(file)
    }
  }
  try {
    visit(dir)
  } catch (error) {
    files.push(failure(error))
  }
  return `--- plugin folder ${JSON.stringify(describePath(dir))}\n${files.sort().join('\n')}`
}

/** Startup contains loader failures; keep it even after requests or a restart. */
export function describeHosts(
  hosts: readonly Pick<HostProcess, 'name' | 'stdout' | 'stderr'>[],
) {
  return hosts
    .map(
      (host, index) =>
        `--- process ${index + 1}: ${host.name}\n--- stdout\n${host.stdout.join('')}\n--- stderr\n${host.stderr.join('')}`,
    )
    .join('\n')
}
