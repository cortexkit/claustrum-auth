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
      for (const rejected of [false, true])
        test(`${host}${rejected ? ' provider 429' : ''}`, async () => {
          const base = path.resolve('target/scratch/live-smoke-e2e')
          mkdirSync(base, { recursive: true })
          const root = mkdtempSync(path.join(base, `${host}-`))
          const home = path.join(root, 'home')
          mkdirSync(home, { recursive: true })
          const mock = await startMock()
          mock.reply = () =>
            rejected
              ? {
                  kind: 'status',
                  status: 429,
                  headers: { 'retry-after': '0' },
                  body: '{"error":{"message":"rate limit","type":"rate_limit_error"}}',
                }
              : { kind: 'ok', text: 'OK' }
          try {
            const fake = path.join(home, 'fake')
            mkdirSync(fake)
            mkdirSync(path.join(fake, 'state'), { mode: 0o700 })
            const tokenPath = await seedEnrollment(path.join(fake, 'state'))
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
              path.join(bundle, 'package.json'),
              JSON.stringify({
                name: 'live-smoke-test',
                type: 'module',
                main: './index.js',
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
                    cerebras: {
                      baseUrl: `${mock.origin}/v1`,
                      api: 'openai-completions',
                      models: [
                        {
                          id: 'm',
                          name: 'm',
                          contextWindow: 8000,
                          maxTokens: 1,
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
              limit: { context: 8000, output: 1 },
              cost: { input: 0, output: 0 },
            }
            const config =
              host === 'opencode2'
                ? {
                    providers: {
                      cerebras: {
                        package: '@ai-sdk/openai-compatible',
                        settings: { baseURL: `${mock.origin}/v1` },
                        models: { m: model },
                      },
                    },
                  }
                : {
                    provider: {
                      cerebras: {
                        npm: '@ai-sdk/openai-compatible',
                        options: { baseURL: `${mock.origin}/v1` },
                        models: { m: model },
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
                binary: binaries,
                plugin: {
                  [host]:
                    host === 'opencode1' || host === 'pi'
                      ? path.join(bundle, 'index.js')
                      : bundle,
                },
                config: { [host]: config },
                skipEnrollment: true,
                env: {
                  CLAUSTRUM_AUTH_E2E_DIR: fake,
                  CLAUSTRUM_AUTH_E2E_ORIGIN: mock.origin,
                  LIVE_SMOKE_TEST_HOST: host,
                  LIVE_SMOKE_TEST_TOKEN_PATH: tokenPath,
                },
              },
            )
            const row = results[0].rows[0]
            const report = readFileSync(results[0].report, 'utf8')
            const evidence = path.resolve(
              '.cortexkit/internal-docs/investigations',
            )
            mkdirSync(evidence, { recursive: true })
            const suffix = rejected ? '-429' : ''
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
            if (rejected) {
              expect(row.turn).not.toStartWith('OK')
              expect(row.turn).not.toBe('not attempted')
              expect(row.turn).not.toBe('Timeout')
            } else expect(row.turn).toStartWith('OK (model: m)')
            expect(/released|removed/.test(row.release)).toBe(true)
            expect(row.leak).toBe('clean')
            const turns = mock.requests
            expect(turns).toHaveLength(1)
            expect(turns[0].headers.authorization).toBe(
              'Bearer fake-vault-cerebras-value',
            )
            const body = JSON.parse(turns[0].body)
            expect(body.max_tokens ?? body.max_completion_tokens).toBe(1)
            expect(report).not.toContain('fake-vault-cerebras-value')
            expect(row.passed).toBe(!rejected)
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
