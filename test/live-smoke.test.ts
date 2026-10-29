import { describe, expect, spyOn, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { PiRpc } from '../packages/pi/test/rpc.ts'
import {
  capPiModels,
  cheapest,
  confined,
  environment,
  errorClass,
  leaks,
  matrix,
  options,
  preview,
  removeLegacyPiCaps,
  runSmoke,
  safe,
  served,
  smokeTokens,
  smokeVariant,
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
  test('smoke selects text and a reasoning-off model before comparing prices', () => {
    for (const host of ['opencode1', 'opencode2'] as const) {
      const models = [
        {
          id: 'image',
          cost: { input: 0, output: 0 },
          capabilities: { output: ['image'] },
        },
        {
          id: 'always-thinking',
          cost: { input: 0, output: 0 },
          variants: [{ id: 'low' }],
        },
        {
          id: 'off',
          cost: { input: 1, output: 1 },
          variants: [{ id: 'none' }, { id: 'low' }],
          capabilities: { output: { text: true } },
        },
      ]
      expect(cheapest(models, host, 'xai').id).toBe('off')
    }
    expect(
      smokeVariant({ id: 'm', variants: { high: {}, low: {}, none: {} } }),
    ).toBe('none')
    expect(
      smokeVariant({
        id: 'm',
        variants: [{ id: 'high' }, { id: 'minimal' }, { id: 'low' }],
      }),
    ).toBe('minimal')
    expect(smokeVariant({ id: 'm', variants: { high: {}, medium: {} } })).toBe(
      'medium',
    )
  })
  test('an absent Typesafe catalog is not misreported as a bearer transport failure', () => {
    for (const host of ['opencode1', 'opencode2'] as const)
      expect(() => cheapest([], host, 'typesafe')).toThrow(
        `NoCatalogModels:${host}:typesafe`,
      )
  })
  test('smoke rejects text models that cannot serve the coding hosts tools', () => {
    for (const host of ['opencode1', 'opencode2'] as const) {
      for (const provider of ['inception', 'openrouter']) {
        expect(
          cheapest(
            [
              {
                id: 'edit-or-audio',
                capabilities: {
                  output: { text: true },
                  ...(host === 'opencode1'
                    ? { toolcall: false }
                    : { tools: false }),
                  reasoning: false,
                },
                cost: { input: 0, output: 0 },
              },
              {
                id: 'chat',
                capabilities: {
                  output: { text: true },
                  ...(host === 'opencode1'
                    ? { toolcall: true }
                    : { tools: true }),
                },
                cost: { input: 1, output: 1 },
              },
            ],
            host,
            provider,
          ).id,
        ).toBe('chat')
      }
    }
  })
  test('smoke leaves bounded answer room when reasoning cannot be disabled', () => {
    for (const host of ['opencode1', 'opencode2', 'pi'] as const) {
      expect(smokeTokens({ id: 'm', reasoning: true }, host, 'meta')).toBe(1024)
      expect(smokeTokens({ id: 'm', reasoning: true }, host, 'inception')).toBe(
        1024,
      )
      expect(
        smokeTokens({ id: 'm', variants: { none: {} } }, host, 'deepseek'),
      ).toBe(16)
      expect(
        smokeTokens(
          {
            id: 'm',
            capabilities: { reasoning: false },
            variants: { high: {} },
          },
          host,
          'cerebras',
        ),
      ).toBe(1024)
    }
    for (const provider of ['cerebras', 'opencode-go'])
      expect(smokeTokens({ id: 'm', reasoning: false }, 'pi', provider)).toBe(
        1024,
      )
  })
  test('Pi caps use overrides rather than replacing catalog reasoning and prices', () => {
    const config: { modelOverrides: Record<string, Record<string, unknown>> } =
      {
        modelOverrides: { m: { reasoning: true, contextWindow: 8000 } },
      }
    capPiModels(config, [{ id: 'm', reasoning: true }], 'meta')
    expect(config).toEqual({
      modelOverrides: {
        m: { reasoning: true, contextWindow: 8000, maxTokens: 1024 },
      },
    })
    const builtin = {}
    capPiModels(builtin, [{ id: 'catalog' }], 'deepseek')
    expect(builtin).toEqual({ modelOverrides: { catalog: { maxTokens: 16 } } })
  })
  test('Pi removes only legacy smoke cap definitions before catalog discovery', () => {
    const config = {
      providers: {
        cerebras: {
          models: [
            { id: 'old', maxTokens: 16 },
            { id: 'custom', name: 'Custom', reasoning: true },
          ],
          modelOverrides: { custom: { maxTokens: 32 } },
        },
      },
    }
    removeLegacyPiCaps(config)
    expect(config.providers.cerebras.models).toEqual([
      { id: 'custom', name: 'Custom', reasoning: true },
    ])
    expect(config.providers.cerebras.modelOverrides).toEqual({
      custom: { maxTokens: 32 },
    })
  })
  test('Pi Zen prefers the offered small Responses model over disabled legacy gpt-5', () => {
    expect(
      cheapest(
        [
          {
            id: 'gpt-5',
            api: 'openai-responses',
            cost: { input: 0, output: 0 },
          },
          {
            id: 'gpt-5.4-mini',
            api: 'openai-responses',
            cost: { input: 1, output: 1 },
          },
        ],
        'pi',
        'opencode-zen',
      ).id,
    ).toBe('gpt-5.4-mini')
    expect(
      cheapest([{ id: 'other', api: 'openai-responses' }], 'pi', 'opencode-zen')
        .id,
    ).toBe('other')
  })
  test('Pi provider status prefixes survive decoding without inspecting identifiers', () => {
    expect(errorClass('412: {"message":"Account suspended"}')).toBe(
      'ProviderHTTP412',
    )
    expect(errorClass('xai API error (403): 403 "No credits"')).toBe(
      'ProviderHTTP403',
    )
    expect(
      errorClass(
        'opencode API error (403): {"message":"Model access is disabled"}',
      ),
    ).toBe('ProviderHTTP403')
    expect(errorClass('400: {"message":"bad model"}')).toBe('ProviderHTTP400')
    expect(errorClass('403: {"message":"request 429abc401"}')).toBe(
      'ProviderHTTP403',
    )
    expect(errorClass('request 412abc403')).toBe('HostError')
  })
  test('OpenCode 2 error events preserve provider status and output-limit provenance', () => {
    for (const status of [400, 402, 403, 412, 429]) {
      expect(
        errorClass(
          JSON.stringify({
            type: 'error',
            error: { type: 'provider.auth', status, message: 'redacted' },
          }),
        ),
      ).toBe(status === 429 ? 'Provider429' : `ProviderHTTP${status}`)
    }
    expect(
      errorClass(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'output-limit',
            message:
              'Response still truncated after two output token limit continuations',
          },
        }),
      ),
    ).toBe('OutputTokenLimit')
    expect(
      errorClass(
        JSON.stringify({
          type: 'error',
          error: { type: 'unknown', message: 'request 429abc401' },
        }),
      ),
    ).toBe('HostError')
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
  test('v1 runtime catalog api.npm identifies the actual model transport', () => {
    const models = v1Models({
      id: 'opencode-go',
      models: {
        opaque: {
          api: { npm: '@ai-sdk/anthropic' },
          cost: { input: 0, output: 0 },
        },
        text: {
          api: { npm: '@ai-sdk/openai-compatible' },
          cost: { input: 1, output: 1 },
        },
      },
    })
    expect(cheapest(models, 'opencode1', 'opencode-go').id).toBe('text')
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
  test('OpenCode hosts keep separate data roots but share the default config and enrolled state', () => {
    const home = mkdtempSync(path.join(scratch, 'env-'))
    const one = environment(home, '/read-only/connection.json', 'opencode1')
    const two = environment(home, '/read-only/connection.json', 'opencode2')
    expect(one.XDG_DATA_HOME).not.toBe(two.XDG_DATA_HOME)
    expect(one.XDG_STATE_HOME).toBe(path.join(home, '.local/state'))
    for (const env of [one, two]) {
      expect(env.XDG_CONFIG_HOME).toBe(path.join(home, '.config'))
      expect(env.OPENCODE_CONFIG_DIR).toBe(path.join(home, '.config/opencode'))
      expect(env.OPENCODE_CONFIG).toBe(
        path.join(home, '.config/opencode/opencode.json'),
      )
    }
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
  test('Pi smoke turns apply thinking off after model selection', async () => {
    class Child extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      stdin = new PassThrough()
      exitCode = null
      signalCode = null
    }
    const child = new Child()
    const rpc = new PiRpc(child as unknown as ChildProcess, true)
    const commands: string[] = []
    child.stdin.on('data', (bytes) => {
      const command = JSON.parse(bytes.toString())
      commands.push(command.type)
      child.stdout.write(
        `${JSON.stringify({ type: 'response', id: command.id, success: true })}\n`,
      )
      if (command.type === 'prompt') {
        child.stdout.write(
          `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } })}\n`,
        )
        child.stdout.write('{"type":"agent_settled"}\n')
      }
    })
    try {
      expect((await rpc.turn('cerebras', 'm', 'Reply OK', 'off')).text).toBe(
        'OK',
      )
      expect(commands).toEqual(['set_model', 'set_thinking_level', 'prompt'])
    } finally {
      child.emit('exit', 0)
      await rpc.exited
    }
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
