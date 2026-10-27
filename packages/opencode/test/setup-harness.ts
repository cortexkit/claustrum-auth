import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { SetupIO } from '@cortexkit/common-auth/setup'
import { bundleOptions } from '../../../scripts/build-options.ts'
import type { runFixtureSetup } from '../setup-test-entry.ts'

let fixtureSetup: Promise<typeof runFixtureSetup> | undefined
export function setupTestBuild() {
  fixtureSetup ??= (async () => {
    const result = await Bun.build({
      ...bundleOptions,
      entrypoints: [path.join(import.meta.dir, '..', 'setup-test-entry.ts')],
      outdir: path.join(import.meta.dir, '..', 'target', 'setup-test'),
    })
    if (!result.success || !result.outputs[0])
      throw new AggregateError(result.logs, 'setup test entry build failed')
    return (await import(result.outputs[0].path))
      .runFixtureSetup as typeof runFixtureSetup
  })()
  return fixtureSetup
}

/** The real setup ceremony and file writers, with deterministic CLI discovery
 * and approval transport. Host activation still runs through each real host. */
export function setupIO(
  root: string,
  overrides: Record<string, string | undefined> = {},
) {
  const bin = path.join(root, 'bin with spaces')
  const env = {
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    PI_CODING_AGENT_DIR: path.join(root, 'pi'),
    ...overrides,
    PATH: bin,
  }
  const proposals: string[] = []
  const commands: { file: string; args: readonly string[] }[] = []
  let output = ''
  const isLauncher = (file: string) =>
    path.dirname(file) === bin &&
    /^(opencode|pi|ck)(\.cmd)?$/u.test(path.basename(file)) &&
    (process.platform === 'win32'
      ? file.endsWith('.cmd')
      : !file.endsWith('.cmd'))
  const stat = (file: string, kind: 'isFile' | 'isDirectory') => {
    try {
      return statSync(file)[kind]()
    } catch {
      return false
    }
  }
  const io: SetupIO = {
    home: (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? root,
    env,
    terminal: {
      input: Object.assign(Readable.from([]), {
        isTTY: false,
        setRawMode() {},
      }),
      output: new Writable({
        write(chunk, _enc, done) {
          output += String(chunk)
          done()
        },
      }),
    },
    fs: {
      exists: (file) =>
        isLauncher(file) ||
        existsSync(file) ||
        file.endsWith('connection.json'),
      isFile: (file) => isLauncher(file) || stat(file, 'isFile'),
      isDirectory: (file) => stat(file, 'isDirectory'),
      isExecutable: isLauncher,
      readText: (file) => readFileSync(file, 'utf8'),
      realpath: (file) => (isLauncher(file) ? file : realpathSync(file)),
    },
    runner: {
      async run(file, args) {
        commands.push({ file, args })
        return { exitCode: 0, stdout: '1.0.0', stderr: '' }
      },
    },
    fence: {
      async listRunningHosts() {
        return []
      },
    },
    connect: async () => ({
      async enrollPropose({ name }) {
        proposals.push(name)
        return { requestId: name }
      },
      async enrollPoll({ requestId }) {
        return {
          status: 'approved',
          name: requestId,
          token: '01'.repeat(32),
          tokenGeneration: 1,
        }
      },
      close() {},
    }),
  }
  return { io, env, proposals, commands, output: () => output }
}
