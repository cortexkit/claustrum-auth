import { execFile } from 'node:child_process'

export interface WindowsProcess {
  pid: number
  parent: number
  name: string
  created: number
}

const marker = 'claustrum-auth-process-snapshot-v1'
const query = `
$ErrorActionPreference = 'Stop'
try {
  $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name;
       created = $(if ($null -eq $_.CreationDate) { 0 } else {
         ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
       }) }
  })
  @{ marker = '${marker}'; processes = $rows } | ConvertTo-Json -Compress -Depth 4
} catch { [Console]::Error.WriteLine($_); exit 1 }
`

/** An empty or failed CIM query is not evidence that the profile is unused. */
export function parseWindowsProcesses(output: string): WindowsProcess[] {
  const result = JSON.parse(output.trim())
  if (result?.marker !== marker || !Array.isArray(result.processes))
    throw new Error(
      'Windows process query did not return its completion marker',
    )
  for (const row of result.processes) {
    if (
      !Number.isInteger(row.pid) ||
      row.pid < 0 ||
      !Number.isInteger(row.parent) ||
      row.parent < 0 ||
      typeof row.name !== 'string' ||
      !row.name ||
      !Number.isFinite(row.created)
    )
      throw new Error('Invalid Windows process query row')
  }
  return result.processes
}

export function windowsProcesses(): Promise<WindowsProcess[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            new Error(`CIM process query failed: ${error.message}; ${stderr}`),
          )
        try {
          resolve(parseWindowsProcesses(stdout))
        } catch (error) {
          reject(error)
        }
      },
    )
  })
}

/** Retain ancestry after a launcher exits, including children of exited children. */
export class WindowsProcessTree {
  private readonly known = new Map<number, WindowsProcess>()
  private alive: WindowsProcess[] = []
  private readonly errors = new Set<string>()
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>

  constructor(
    readonly root: number,
    private readonly snapshot = windowsProcesses,
    private readonly started = Date.now(),
    private readonly rootRunning = () => true,
  ) {}

  start() {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 250)
    this.timer.unref()
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.capture().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async capture() {
    try {
      const rows = await this.snapshot()
      const root = rows.find((row) => row.pid === this.root)
      // CIM and JS clocks have millisecond precision. Never adopt an older,
      // unrelated process if Windows has already reused the launcher's PID.
      if (
        !this.known.has(this.root) &&
        this.rootRunning() &&
        root &&
        root.created >= this.started
      )
        this.known.set(root.pid, root)
      let added: boolean
      do {
        added = false
        for (const row of rows) {
          if (this.known.has(row.pid)) continue
          const parent = this.known.get(row.parent)
          const born =
            parent?.created ??
            (row.parent === this.root ? this.started : undefined)
          const currentParent = rows.find(
            (candidate) => candidate.pid === row.parent,
          )
          if (!parent && currentParent) continue
          if (born === undefined || row.created < born) continue
          // A newer process with the same parent PID is not part of this tree.
          if (currentParent && currentParent.created !== born) continue
          this.known.set(row.pid, row)
          added = true
        }
      } while (added)
      this.alive = rows.filter(
        (row) => this.known.get(row.pid)?.created === row.created,
      )
    } catch (error) {
      this.errors.add(String(error))
      // Do not act on a stale snapshot: a PID may have been reused meanwhile.
      this.alive = []
    }
  }

  async stop(kill: (pid: number) => void, timeout = 15_000) {
    clearInterval(this.timer)
    await this.pending
    const deadline = Date.now() + timeout
    do {
      await this.refresh()
      if (!this.alive.length) break
      for (const row of this.alive) kill(row.pid)
      await Bun.sleep(100)
    } while (Date.now() < deadline)
    await this.refresh()
    return [
      ...[...this.errors].map((error) => `process tracking failed: ${error}`),
      ...this.alive.map(
        (row) =>
          `still alive: ${row.name} (pid ${row.pid}, parent ${row.parent})`,
      ),
    ]
  }

  async describe() {
    await this.refresh()
    return JSON.stringify({
      root: this.root,
      alive: this.alive,
      recorded: [...this.known.values()],
      errors: [...this.errors],
    })
  }
}
