import { describe, expect, test } from 'bun:test'
import { removeProfile } from './cleanup.ts'
import {
  parseWindowsProcesses,
  type WindowsProcess,
  WindowsProcessTree,
} from './windows-processes.ts'

const row = (
  pid: number,
  parent: number,
  name = 'opencode.exe',
  created = pid,
): WindowsProcess => ({ pid, parent, name, created })

describe('Windows host process tracking', () => {
  test('stops descendants after launcher and intermediate parent exit', async () => {
    let rows = [row(3, 2, 'git.exe'), row(2, 1), row(1, 0, 'cmd.exe')]
    const tree = new WindowsProcessTree(1, async () => rows, 0)
    await tree.refresh()
    // The CLI has finished and closed its pipes, but its helper is still alive.
    rows = [row(3, 2, 'git.exe'), row(4, 3, 'watcher.exe')]
    const killed: number[] = []
    const problems = await tree.stop((pid) => {
      killed.push(pid)
      rows = rows.filter((process) => process.pid !== pid)
    })
    expect(killed).toEqual([3, 4])
    expect(problems).toEqual([])
    expect(JSON.parse(await tree.describe()).alive).toEqual([])
  })

  test('finds children even when the launcher exited before the first snapshot', async () => {
    let rows = [row(2, 1)]
    const tree = new WindowsProcessTree(1, async () => rows, 0)
    const killed: number[] = []
    expect(
      await tree.stop((pid) => {
        killed.push(pid)
        rows = []
      }),
    ).toEqual([])
    expect(killed).toEqual([2])
  })

  test('does not kill reused PIDs or their unrelated children', async () => {
    let rows = [row(1, 0), row(2, 1)]
    const tree = new WindowsProcessTree(1, async () => rows, 0)
    await tree.refresh()
    rows = [
      row(2, 0, 'unrelated.exe', 10),
      row(3, 2, 'unrelated-child.exe', 11),
    ]
    const killed: number[] = []
    expect(await tree.stop((pid) => killed.push(pid))).toEqual([])
    expect(killed).toEqual([])
  })

  test('does not adopt a reused launcher PID after its exit', async () => {
    const tree = new WindowsProcessTree(
      1,
      async () => [
        row(1, 0, 'unrelated.exe', 10),
        row(2, 1, 'unrelated-child.exe', 11),
      ],
      0,
      () => false,
    )
    const killed: number[] = []
    expect(await tree.stop((pid) => killed.push(pid))).toEqual([])
    expect(killed).toEqual([])
  })

  test('waits for killed processes to disappear from CIM', async () => {
    let snapshots = 0
    let killed = false
    const tree = new WindowsProcessTree(
      1,
      async () => {
        snapshots++
        return killed && snapshots >= 3 ? [] : [row(1, 0)]
      },
      0,
    )
    expect(
      await tree.stop(() => {
        killed = true
      }),
    ).toEqual([])
    expect(snapshots).toBeGreaterThanOrEqual(3)
  })

  test('names processes that survive termination', async () => {
    const tree = new WindowsProcessTree(
      1,
      async () => [row(2, 1, 'git.exe')],
      0,
    )
    expect(await tree.stop(() => {}, 0)).toEqual([
      'still alive: git.exe (pid 2, parent 1)',
    ])
  })

  test('fails closed when process enumeration fails, even if a later query succeeds', async () => {
    let failing = true
    const tree = new WindowsProcessTree(
      1,
      async () => {
        if (failing) throw new Error('CIM unavailable')
        return []
      },
      0,
    )
    await tree.refresh()
    failing = false
    expect(await tree.stop(() => {})).toEqual([
      'process tracking failed: Error: CIM unavailable',
    ])
  })

  test('requires a completion marker and validates process rows', () => {
    expect(() => parseWindowsProcesses('')).toThrow()
    expect(() => parseWindowsProcesses('{"processes":[]}')).toThrow(
      'completion marker',
    )
    const encode = (processes: unknown[]) =>
      JSON.stringify({
        marker: 'claustrum-auth-process-snapshot-v1',
        processes,
      })
    expect(parseWindowsProcesses(encode([]))).toEqual([])
    expect(parseWindowsProcesses(encode([row(2, 1)]))).toEqual([row(2, 1)])
    expect(() => parseWindowsProcesses(encode([{ pid: '2' }]))).toThrow(
      'Invalid Windows process query row',
    )
  })

  test('removal failure names the first path and surviving process, without swallowing EPERM', async () => {
    const tree = new WindowsProcessTree(
      1,
      async () => [row(2, 1, 'git.exe')],
      0,
    )
    let attempts = 0
    const remove: typeof import('node:fs/promises').rm = async (
      _path,
      options,
    ) => {
      attempts++
      expect(options?.maxRetries).toBe(process.platform === 'win32' ? 2 : 0)
      throw Object.assign(new Error('EPERM: locked'), {
        path: 'profile/opencode.db',
        code: 'EPERM',
      })
    }
    const pending = removeProfile(
      'profile',
      [{ name: 'login', child: { pid: 1, exitCode: 0 }, tree }],
      remove,
    )
    let message = ''
    try {
      await pending
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('first undeleted path: profile/opencode.db')
    expect(message).toContain('EPERM')
    expect(message).toContain('login (pid 1, exit 0)')
    expect(message).toContain('"alive":[{"pid":2,"parent":1,"name":"git.exe"')
    expect(attempts).toBe(1)
  })
})
