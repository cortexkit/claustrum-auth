import { describe, expect, spyOn, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { PiRpc } from '../packages/pi/test/rpc.ts'
import {
  cheapest,
  confined,
  environment,
  leaks,
  matrix,
  options,
  preview,
  runSmoke,
  safe,
  served,
  table,
  v1Models,
} from '../scripts/live-smoke/run.ts'

const scratch = path.resolve('target/scratch/live-smoke-unit')
mkdirSync(scratch, { recursive: true })

describe('live smoke safety', () => {
  test('rejects symlink escapes before a spawn', () => {
    const home = mkdtempSync(path.join(scratch, 'home-'))
    symlinkSync(path.dirname(home), path.join(home, 'escape'))
    expect(() => confined(home, path.join(home, 'escape/new'))).toThrow(
      'PathOutsideLiveHome',
    )
  })
  test('leak offsets are bytes and reports never reproduce a match', () => {
    const secret = `sk-${'a'.repeat(40)}`
    const bytes = Buffer.from(`é ${secret}`)
    expect(leaks('log', bytes)).toEqual([{ file: 'log', offset: 3 }])
    expect(safe(secret)).not.toContain(secret)
    expect(
      leaks('auth', Buffer.from(`Authorization: ${'A'.repeat(40)}`)).length,
    ).toBe(1)
    expect(
      leaks(
        'jwt',
        Buffer.from('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'),
      ).length,
    ).toBe(1)
    expect(
      table('pi', [
        {
          provider: 'meta',
          status: secret,
          activation: '',
          turn: secret,
          extras: '',
          release: '',
          leak: '',
        },
      ]),
    ).not.toContain(secret)
  })
  test('status refuses disabled accounts rather than borrowing another provider state', () => {
    const accounts =
      'cerebras: 1 vault account(s)\n  1. row [route]: active, disabled\nxai: 1 vault account(s)\n  1. other [other]: active, enabled'
    expect(
      served(
        'cerebras',
        'cerebras',
        'Vault: reachable\ncerebras: available',
        'None.',
        accounts,
      ),
    ).toStartWith('refused: active, disabled')
    expect(
      served(
        'xai',
        'xai',
        'Vault: unreachable\nxai: available',
        'None.',
        accounts,
      ),
    ).toStartWith('refused: Vault: unreachable')
    expect(
      served(
        'opencode-zen',
        'opencode-zen',
        'Vault: reachable',
        '  apikey:opencode-zen: not-on-this-host',
        '',
      ),
    ).toBe('refused: apikey:opencode-zen: not-on-this-host')
  })
  test('provider matrix excludes unsupported Pi providers but checks zen refusal on OpenCode2', () => {
    expect(matrix('pi')).not.toContain('cline-pass')
    expect(matrix('opencode2')).toContain('opencode-zen')
  })
  test('selects lowest catalog price and excludes Anthropic from bearer-only providers', () => {
    expect(
      cheapest(
        [
          { id: 'claude-haiku', cost: { input: 0, output: 0 } },
          { id: 'glm-5.3', cost: { input: 1, output: 2 } },
          { id: 'expensive', cost: { input: 10, output: 20 } },
        ],
        'opencode2',
        'opencode-go',
      ).id,
    ).toBe('glm-5.3')
  })
  test('v1 model package overrides, not model names or API URLs, select transport', () => {
    const models = v1Models({
      id: 'opencode-go',
      npm: '@ai-sdk/openai-compatible',
      models: {
        gemini: {
          provider: { npm: '@ai-sdk/google' },
          cost: { input: 0, output: 0 },
        },
        opaque: {
          provider: { npm: '@ai-sdk/anthropic' },
          cost: { input: 0, output: 0 },
        },
        'claude-proxied': { cost: { input: 1, output: 1 } },
      },
    })
    expect(cheapest(models, 'opencode1', 'opencode-go').id).toBe(
      'claude-proxied',
    )
    expect(cheapest(models, 'opencode1', 'opencode-go', true).id).toBe('opaque')
  })
  test('dry plan executes nothing and leaves the scratch home untouched', async () => {
    const home = mkdtempSync(path.join(scratch, 'dry-'))
    const output = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runSmoke(
        {
          home,
          connection: path.join(home, 'missing.json'),
          hosts: ['opencode1', 'opencode2', 'pi'],
          provider: 'cerebras',
          dry: true,
        },
        { skipEnrollment: true },
      )
      expect(readdirSync(home)).toEqual([])
      expect(output.mock.calls[0][0]).toContain(
        'auth login cerebras --method claustrum-auth',
      )
      expect(output.mock.calls[0][0]).toContain('RPC consent: true')
    } finally {
      output.mockRestore()
    }
  })
  test('each host has separate data roots and shares only the enrolled state root', () => {
    const home = mkdtempSync(path.join(scratch, 'env-'))
    const one = environment(home, '/read-only/connection.json', 'opencode1')
    const two = environment(home, '/read-only/connection.json', 'opencode2')
    expect(one.XDG_DATA_HOME).not.toBe(two.XDG_DATA_HOME)
    expect(one.XDG_STATE_HOME).toBe(path.join(home, '.local/state'))
    expect(one.HOME).toBe(home)
    expect(one.OPENCODE_PASSWORD === one.OPENCODE_SERVER_PASSWORD).toBe(true)
    expect(one.OPENCODE_PASSWORD !== two.OPENCODE_PASSWORD).toBe(true)
    expect(Object.keys(one)).not.toContain('OPENAI_API_KEY')
  })
  test('all requested credential shapes are detected without including values in findings', () => {
    for (const prefix of ['Bearer ', 'sk-', 'csk-', 'xai-', 'fw_', 'sk-or-']) {
      expect(
        leaks('out', Buffer.from(`${prefix}${'Q'.repeat(40)}`))[0],
      ).toEqual({ file: 'out', offset: 0 })
    }
  })
  test('auth context applies to its value, not a nearby catalog model name', () => {
    expect(
      leaks(
        'catalog',
        Buffer.from(
          `"apiKey":"public","models":{"${'model-name-'.repeat(5)}":{}}}`,
        ),
      ),
    ).toEqual([])
    expect(
      leaks('header', Buffer.from(`Authorization:\n  ${'Q'.repeat(40)}`))[0],
    ).toEqual({ file: 'header', offset: 0 })
  })
  test('RPC decoding preserves raw bytes for the independent leak recorder', async () => {
    class Child extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      stdin = new PassThrough()
      exitCode = null
      signalCode = null
    }
    const child = new Child()
    const raw: Buffer[] = []
    child.stdout.on('data', (b) => raw.push(b))
    const rpc = new PiRpc(child as unknown as ChildProcess, true)
    const bytes = Buffer.from(
      `${JSON.stringify({ type: 'extension_ui_request', method: 'notify', message: 'é' })}\n`,
    )
    const at = bytes.indexOf(Buffer.from('é')) + 1
    child.stdout.write(bytes.subarray(0, at))
    child.stdout.write(bytes.subarray(at))
    expect(rpc.notices).toEqual(['é'])
    expect(Buffer.concat(raw)).toEqual(bytes)
    child.emit('exit', 0)
    await rpc.exited
  })
  test('OAuth-shaped access fields are authorization contexts', () => {
    expect(
      leaks('oauth', Buffer.from(`"access":"${'A'.repeat(40)}"`))[0],
    ).toEqual({ file: 'oauth', offset: 1 })
  })
  test('answer previews redact before truncating a credential-shaped suffix', () => {
    expect(preview(`${'x'.repeat(30)} sk-${'A'.repeat(40)}`)).toBe(
      '[credential-shaped output withheld]',
    )
  })
  test('all hosts plus one provider selects only hosts that list it', () => {
    const home = mkdtempSync(path.join(scratch, 'select-'))
    expect(
      options(['--host', 'all', '--provider', 'cline-pass'], {
        LIVE_HOME: home,
        CLAUSTRUM_SUBC_CONNECTION: '/read-only/connection.json',
      }).hosts,
    ).toEqual(['opencode1', 'opencode2'])
  })
  test('an already-overridden HOME does not make the scratch profile a real home', () => {
    const home = mkdtempSync(path.join(scratch, 'home-env-'))
    const previous = process.env.HOME
    process.env.HOME = home
    try {
      expect(
        options([], {
          LIVE_HOME: home,
          CLAUSTRUM_SUBC_CONNECTION: '/read-only/connection.json',
        }).home,
      ).toBe(home)
      expect(() =>
        options([], {
          LIVE_HOME: userInfo().homedir,
          CLAUSTRUM_SUBC_CONNECTION: '/read-only/connection.json',
        }),
      ).toThrow('LiveHomeMustBeScratch')
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
    }
  })
  test('invalid flags fail closed', () => {
    expect(() => options(['--host', 'typo'])).toThrow()
  })
})
