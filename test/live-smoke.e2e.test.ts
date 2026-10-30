import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  hostBinary,
  seedEnrollment,
  startMock,
  vaultRow,
} from '../packages/opencode/test/e2e/host.ts'
import { enroll } from '../packages/pi/test/harness.ts'
import { bundleOptions } from '../scripts/build-options.ts'
import {
  environment,
  type Host,
  runSmoke,
  safe,
} from '../scripts/live-smoke/run.ts'

const enabled = process.env.CLAUSTRUM_AUTH_LIVE_SMOKE_E2E === '1'
describe.skipIf(!enabled)(
  'headless live smoke on real hosts with fake vault',
  () => {
    for (const host of ['opencode1', 'opencode2', 'pi'] as Host[])
      for (const rejected of [
        false,
        true,
        'reasoning',
        ...(host === 'pi' ? ['legacy-caps'] : []),
        ...(host === 'opencode2' ? ['length'] : []),
      ])
        test(`${host}${rejected === 'legacy-caps' ? ' legacy caps startup' : rejected === 'reasoning' ? ' reasoning answer budget' : rejected === 'length' ? ' output-limit continuation budget' : rejected ? ' provider 429' : ''}`, async () => {
          const reasoning = rejected === 'reasoning'
          const failed =
            Boolean(rejected) && !reasoning && rejected !== 'legacy-caps'
          const base = path.resolve('target/scratch/live-smoke-e2e')
          mkdirSync(base, { recursive: true })
          const root = mkdtempSync(path.join(base, `${host}-`))
          const home = path.join(root, 'home')
          mkdirSync(home, { recursive: true })
          const mock = await startMock()
          mock.reply = (request) => {
            const payload = JSON.parse(request.body)
            if (reasoning)
              console.log('fake reasoning request', {
                host,
                model: payload.model,
                cap: payload.max_tokens ?? payload.max_completion_tokens,
                effort: payload.reasoning_effort,
              })
            return rejected === 'length'
              ? { kind: 'ok', text: '', finish: 'length' }
              : reasoning &&
                  (payload.max_tokens ?? payload.max_completion_tokens) < 128
                ? { kind: 'ok', text: '', finish: 'length' }
                : failed
                  ? {
                      kind: 'status',
                      status: 429,
                      headers: { 'retry-after': '0' },
                      body: '{"error":{"message":"rate limit","type":"rate_limit_error"}}',
                    }
                  : { kind: 'ok', text: 'OK' }
          }
          try {
            const fake = path.join(home, 'fake')
            mkdirSync(fake)
            // Seed the default install location independently of the driver's
            // environment, so a config-folder override cannot hide a mismatch.
            const state = path.join(
              home,
              '.local/state/cortexkit/claustrum-auth/opencode',
            )
            mkdirSync(state, { recursive: true, mode: 0o700 })
            await seedEnrollment(state)
            writeFileSync(path.join(home, 'connection.json'), '{}')
            writeFileSync(
              path.join(fake, 'vault.json'),
              JSON.stringify({
                active: true,
                outage: false,
                rows: [vaultRow('apikey:cerebras', 'cerebras')],
                served: {
                  'apikey:cerebras': { material: 'fake-vault-cerebras-value' },
                },
              }),
            )
            const bundle = path.join(root, 'fixture')
            const build = await Bun.build({
              ...bundleOptions,
              entrypoints: ['test/live-smoke-plugin.ts'],
              outdir: bundle,
              naming: 'index.js',
              external: [
                ...bundleOptions.external,
                '@earendil-works/pi-coding-agent',
              ],
            })
            expect(build.success).toBe(true)
            symlinkSync(
              path.resolve('packages/pi/node_modules'),
              path.join(bundle, 'node_modules'),
              'dir',
            )
            writeFileSync(
              path.join(bundle, 'server.js'),
              "export {serverPlugin as default} from './index.js'\n",
            )
            // Match the published split entries and conditional server export.
            // The legacy default deliberately has no OpenCode 2 setup hook.
            writeFileSync(
              path.join(bundle, 'package.json'),
              JSON.stringify({
                name: 'live-smoke-test',
                type: 'module',
                main: './index.js',
                exports: {
                  '.': { types: './index.d.ts', import: './index.js' },
                  './server': {
                    types: './server.d.ts',
                    import: './server.js',
                  },
                },
              }),
            )
            const env = environment(home, path.join(home, 'connection.json'))
            for (const p of [
              env.XDG_CACHE_HOME,
              env.TMPDIR,
              env.PI_CODING_AGENT_DIR,
            ])
              mkdirSync(p, { recursive: true })
            const binaries: Partial<Record<Host, string>> = {}
            if (host === 'opencode1') binaries[host] = hostBinary()
            if (host === 'opencode2') {
              const cliDir = path.resolve(
                process.env.CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR ??
                  'target/opencode2-cli',
              )
              const cli = path.join(cliDir, 'node_modules/.bin/opencode2')
              if (!existsSync(cli)) {
                const install = spawnSync(
                  'npm',
                  [
                    'install',
                    '--prefix',
                    cliDir,
                    '--no-audit',
                    '--no-fund',
                    '@opencode/cli@2.2.0',
                  ],
                  { env, encoding: 'utf8', timeout: 600_000 },
                )
                expect(install.status).toBe(0)
              }
              const version = spawnSync(cli, ['--version'], {
                env,
                encoding: 'utf8',
                timeout: 20_000,
              })
              expect(version.status).toBe(0)
              expect(version.stdout.trim()).toBe('opencode v2.2.0')
              binaries[host] = cli
            }
            if (host === 'pi') {
              writeFileSync(
                path.join(env.PI_CODING_AGENT_DIR, 'auth.json'),
                JSON.stringify({
                  cerebras: { type: 'api_key', key: 'fake-own-key' },
                }),
              )
              const pi = path.join(root, 'pi')
              const cli = path.join(
                path.dirname(
                  Bun.resolveSync(
                    '@earendil-works/pi-coding-agent',
                    import.meta.dir,
                  ),
                ),
                'bundle/cli.js',
              )
              writeFileSync(
                pi,
                `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`,
              )
              chmodSync(pi, 0o700)
              binaries[host] = pi
              mkdirSync(path.join(env.PI_CODING_AGENT_DIR, 'claustrum-auth'), {
                recursive: true,
                mode: 0o700,
              })
              await enroll(env.PI_CODING_AGENT_DIR)
              writeFileSync(
                path.join(env.PI_CODING_AGENT_DIR, 'models.json'),
                JSON.stringify({
                  providers: {
                    ...(rejected === 'legacy-caps'
                      ? {
                          meta: { models: [{ id: 'old', maxTokens: 16 }] },
                          xai: { models: [] },
                        }
                      : {}),
                    cerebras: {
                      baseUrl: `${mock.origin}/v1`,
                      api: 'openai-completions',
                      models: [
                        {
                          id: 'm',
                          name: 'm',
                          contextWindow: 8000,
                          maxTokens: 4096,
                          reasoning: true,
                          thinkingLevelMap: { off: 'none' },
                          cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                          },
                        },
                      ],
                    },
                  },
                }),
              )
            }
            const model = {
              name: 'm',
              limit: { context: 8000, output: 4096 },
              cost: { input: 0, output: 0 },
            }
            const config =
              host === 'opencode2'
                ? {
                    providers: {
                      cerebras: {
                        package: '@ai-sdk/openai-compatible',
                        settings: { baseURL: `${mock.origin}/v1` },
                        models: {
                          m: {
                            ...model,
                            settings: { reasoningEffort: 'high' },
                            variants: [
                              {
                                id: reasoning ? 'low' : 'high',
                                settings: {
                                  reasoningEffort: reasoning ? 'low' : 'high',
                                },
                              },
                              ...(!reasoning
                                ? [
                                    {
                                      id: 'none',
                                      settings: { reasoningEffort: 'none' },
                                    },
                                  ]
                                : []),
                            ],
                          },
                        },
                      },
                    },
                  }
                : {
                    provider: {
                      cerebras: {
                        npm: '@ai-sdk/openai-compatible',
                        options: { baseURL: `${mock.origin}/v1` },
                        models: {
                          m: {
                            ...model,
                            reasoning: true,
                            options: { reasoningEffort: 'high' },
                            variants: {
                              high: { reasoningEffort: 'high' },
                              ...(!reasoning
                                ? { none: { reasoningEffort: 'none' } }
                                : {}),
                            },
                          },
                        },
                      },
                    },
                  }
            const results = await runSmoke(
              {
                home,
                connection: path.join(home, 'connection.json'),
                hosts: [host],
                provider: 'cerebras',
                dry: false,
              },
              {
                onError: (error) =>
                  console.error('private fake error:', safe(String(error))),
                // The budget fixture must exercise its reasoning model, not a
                // non-reasoning model preferred by the host-catalog ranking.
                models: reasoning
                  ? (models) => models.filter((m) => m.id === 'm')
                  : undefined,
                binary: binaries,
                plugin: {
                  [host]:
                    host === 'opencode1' || host === 'pi'
                      ? path.join(bundle, 'index.js')
                      : bundle,
                },
                config: { [host]: config },
                env: {
                  CLAUSTRUM_AUTH_E2E_DIR: fake,
                  CLAUSTRUM_AUTH_E2E_ORIGIN: mock.origin,
                  LIVE_SMOKE_TEST_HOST: host,
                },
              },
            )
            const row = results[0].rows[0]
            const report = readFileSync(results[0].report, 'utf8')
            const evidence = path.resolve(
              '.cortexkit/internal-docs/investigations',
            )
            mkdirSync(evidence, { recursive: true })
            const suffix = reasoning
              ? '-reasoning'
              : rejected === 'legacy-caps'
                ? '-legacy-caps'
                : rejected === 'length'
                  ? '-length'
                  : rejected
                    ? '-429'
                    : ''
            writeFileSync(
              path.join(evidence, `live-smoke-${host}${suffix}.md`),
              report,
            )
            const logs = path.join(home, '.live-smoke', host)
            writeFileSync(
              path.join(evidence, `live-smoke-debug-${host}${suffix}.md`),
              readdirSync(logs)
                .filter(
                  (f) =>
                    /child-.*\.(stderr|stdout)$/.test(f) ||
                    ['api-1.json', 'api-2.json'].includes(f),
                )
                .map(
                  (f) =>
                    `${f}\n${readFileSync(path.join(logs, f), 'utf8').split('\n').map(safe).join('\n')}`,
                )
                .join('\n\n'),
            )
            expect(row.status).toStartWith('served:')
            expect(row.activation).toBe('activated')
            if (failed) {
              expect(row.turn).not.toStartWith('OK')
              expect(row.turn).not.toBe('not attempted')
              expect(row.turn).not.toBe('Timeout')
            } else expect(row.turn).toStartWith('OK (model: m)')
            expect(/released|removed/.test(row.release)).toBe(true)
            expect(row.leak).toBe('clean')
            const turns = mock.requests
            expect(turns).toHaveLength(1)
            if (rejected === 'length')
              expect(row.turn).toBe('RequestBudgetExhausted')
            expect(turns[0].headers.authorization).toBe(
              'Bearer fake-vault-cerebras-value',
            )
            const body = JSON.parse(turns[0].body)
            expect(body.max_tokens ?? body.max_completion_tokens).toBe(
              host === 'pi' || reasoning ? 1024 : 16,
            )
            expect(body.model).toBe('m')
            if (host === 'pi') {
              expect(body.reasoning_effort).toBe('none')
              const saved = JSON.parse(
                readFileSync(
                  path.join(env.PI_CODING_AGENT_DIR, 'models.json'),
                  'utf8',
                ),
              )
              expect(saved.providers.cerebras.modelOverrides.m.maxTokens).toBe(
                1024,
              )
              expect(saved.providers.cerebras.models[0].maxTokens).toBe(4096)
            } else {
              expect(body.reasoning_effort).toBe(reasoning ? 'low' : 'none')
              const saved = JSON.parse(
                readFileSync(env.OPENCODE_CONFIG, 'utf8'),
              )
              expect(
                saved[host === 'opencode1' ? 'provider' : 'providers'].cerebras
                  .models.m.limit.output,
              ).toBe(reasoning ? 1024 : 16)
              if (host === 'opencode1') {
                const initial = JSON.parse(
                  readFileSync(path.join(logs, 'api-1.json'), 'utf8'),
                )
                expect(initial.provider.cerebras.models.m.limit.output).toBe(
                  4096,
                )
              }
            }
            expect(report).not.toContain('fake-vault-cerebras-value')
            expect(row.passed).toBe(!failed)
            expect(report).not.toContain('fake-own-key')
            if (host === 'pi') {
              expect(
                readFileSync(
                  path.join(env.PI_CODING_AGENT_DIR, 'auth.json'),
                  'utf8',
                ),
              ).toContain('fake-own-key')
            }
          } finally {
            await mock.close()
          }
        }, 900_000)
  },
)
