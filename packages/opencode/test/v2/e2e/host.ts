// Process handling for the real OpenCode 2 tests, adapted from common-auth's
// placement harness (test/opencode2/e2e/host-process.ts there): spawning the
// CLI, launching npm's Windows batch shims through cmd.exe with fixed
// arguments, and stopping a whole process tree.
//
// On Windows npm's `opencode2.cmd` starts the native executable as a child of
// cmd.exe, and Bun's `kill()` ends only cmd.exe; the orphan keeps the output
// pipes and the test profile open. `taskkill /T /F` ends the whole tree.
// Every wait is bounded, so a process that outlives its stop fails the
// scenario with a report instead of hanging it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

export const isWindows = process.platform === 'win32'

/** Prefer native executables and Windows batch shims over npm's POSIX shims. */
export function executable(file: string) {
  const candidates = isWindows
    ? ['.exe', '.cmd', '.bat', ''].map((suffix) => file + suffix)
    : [file]
  return candidates.find((candidate) => existsSync(candidate))
}

/** Only fixed harness arguments are admitted to cmd.exe, never shell syntax. */
export function launch(file: string, args: string[]): [string, ...string[]] {
  if (!isWindows || !/\.(cmd|bat)$/i.test(file)) return [file, ...args]
  if ([file, ...args].some((value) => /["%!\r\n]/.test(value)))
    throw new Error('Unsafe batch launcher argument')
  return [
    'cmd.exe',
    '/d',
    '/s',
    '/c',
    `""${file}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
  ]
}

export interface HostProcess {
  readonly name: string
  readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  readonly stdout: string[]
  readonly stderr: string[]
  readonly drained: Promise<void>
  outputClosed: boolean
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: string[],
) {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }))
}

export function spawnHost(
  name: string,
  argv: [string, ...string[]],
  options: { cwd: string; env: Record<string, string> },
): HostProcess {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Arguments reach cmd.exe exactly as the launcher quoted them.
    windowsVerbatimArguments: true,
  })
  const stdout: string[] = []
  const stderr: string[] = []
  const host: HostProcess = {
    name,
    child,
    stdout,
    stderr,
    outputClosed: false,
    drained: Promise.all([
      collect(child.stdout, stdout),
      collect(child.stderr, stderr),
    ]).then(
      () => {
        host.outputClosed = true
      },
      () => {
        host.outputClosed = true
      },
    ),
  }
  return host
}

/** Resolves true when `pending` settles within `ms`, false otherwise. */
export async function within(pending: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([pending.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

export function killTree(pid: number) {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/** Stops the host and waits, within bounds, for it to exit and close output. */
export async function stopHost(host: HostProcess) {
  const { child } = host
  const problems: string[] = []
  if (child.exitCode === null && child.signalCode === null) {
    if (isWindows) killTree(child.pid)
    else {
      child.kill('SIGTERM')
      if (!(await within(child.exited, 10_000))) child.kill('SIGKILL')
    }
  }
  if (!(await within(child.exited, 15_000)))
    problems.push(`${host.name} (pid ${child.pid}) did not exit`)
  if (!(await within(host.drained, 5_000)))
    problems.push(
      `${host.name} exited but a process it started holds its output`,
    )
  return problems
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * An environment whose every home, config, data, state, cache and temp root
 * is inside `root`, on every OS: `HOME` for macOS and Linux, `USERPROFILE`,
 * `APPDATA` and `LOCALAPPDATA` for Windows. Anything that is not loopback goes
 * to a dead proxy, so a misrouted request fails instead of leaving the machine.
 */
export function isolatedEnv(root: string, extra: Record<string, string> = {}) {
  const dirs = {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return {
    PATH: process.env.PATH ?? '',
    ...(isWindows
      ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
      : {}),
    ...dirs,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...extra,
  }
}
