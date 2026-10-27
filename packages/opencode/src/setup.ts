import { homedir } from 'node:os'
import path from 'node:path'
import {
  type CoreOptions,
  command,
  createCore,
  type Host,
  opencodeEnrollment,
  type ProviderEntry,
  piEnrollment,
  supportedProviders,
} from '@cortexkit/claustrum-auth-core'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import { printLine, processTerminal } from '@cortexkit/common-auth/auth-menu'
import {
  connectClaustrumScopedClient,
  enrollmentAuthority,
  hostEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  type VaultGrantReach,
} from '@cortexkit/common-auth/claustrum'
import {
  detectHosts,
  runSetup,
  type SetupCallbackContext,
  type SetupHost,
  type SetupIO,
  type SetupPlugin,
} from '@cortexkit/common-auth/setup'
import piPackage from '../../pi/package.json'
import opencodePackage from '../package.json'
import { opencodeStateDir, resolveOpencodeStateDir } from './state-dir.js'
import { vaultMethodId } from './v2/setup.js'

export interface ClaustrumSetupOptions {
  table: readonly ProviderEntry[]
  createCore(options: CoreOptions): ReturnType<typeof createCore>
}

export const vaultOnlyMessage = 'This plugin serves vault keys only.'

export const setupUsage = [
  'Usage: claustrum-auth [options]',
  'Set up the vault-only claustrum-auth plugin for OpenCode and Pi.',
  '  --dry-run                 Preview enrollment and registration without changes',
  '  --yes                     Set up detected hosts without prompting',
  '  --host <opencode|pi>       Select one host (also accepts --host=<host>)',
  '  --opencode=1|2|both        Choose the OpenCode generation',
  '  --enroll-only             Enroll without changing host configuration',
  '  --claustrum               Compatibility flag; vault mode is always enabled',
  '  --help                    Print this usage text without running setup',
].join('\n')

/** Setup guides activation; only a host may change its own credentials. */
export async function runClaustrumSetup(
  argv: string[] = [],
  io: SetupIO = {},
  options: ClaustrumSetupOptions = { table: supportedProviders, createCore },
) {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const terminal = io.terminal ?? processTerminal()
  const print = (text: string) => printLine(terminal, text)
  if (argv.includes('--help')) {
    print(setupUsage)
    return
  }
  if (argv.includes('--no-claustrum') || argv.includes('--login'))
    throw new Error(vaultOnlyMessage)
  const setupArgv = ['--claustrum']
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '--claustrum') continue
    if (
      arg === '--host' &&
      argv[index + 1] &&
      !argv[index + 1]?.startsWith('--')
    ) {
      setupArgv.push(`--host=${argv[++index]}`)
    } else setupArgv.push(arg)
  }
  const states = {
    opencode: resolveOpencodeStateDir(env, home),
    pi: '',
  }
  const connectionFile = resolveClaustrumConnectionPath()
  const plugin: SetupPlugin = {
    packages: { opencode: opencodePackage.name, pi: piPackage.name },
    version: opencodePackage.version,
    displayName: 'claustrum-auth plugin',
    slashCommand: command,
    vault: {
      connectionFile,
      hosts: {
        opencode: {
          name: opencodeEnrollment,
          paths: { stateDir: states.opencode, host: 'opencode' },
        },
        pi: { name: piEnrollment, paths: { stateDir: '', host: 'pi' } },
      },
    },
    beforeSignIn: async (host, context) => {
      if (context.mode !== 'claustrum') throw new Error(vaultOnlyMessage)
      if (host === 'opencode') await opencodeStateDir(env, home)
    },
    signInLocal: async () => {
      throw new Error(vaultOnlyMessage)
    },
    // The current shared setup requires this callback; vault keys need no migration.
    migrate: async () => {},
    beforeRegister: async (host, mode, context) => {
      if (mode !== 'claustrum') throw new Error(vaultOnlyMessage)
      await guidance(host, context.opencodeGeneration, true)
    },
  }
  // Use the shared resolver, including Pi's file URL and home expansion rules.
  const detection = await detectHosts(plugin, io)
  states.pi = path.join(detection.pi.directory, 'claustrum-auth')
  plugin.vault.hosts.pi.paths.stateDir = states.pi

  async function guidance(
    host: SetupHost,
    generation: SetupCallbackContext['opencodeGeneration'],
    discover: boolean,
  ) {
    const enrollment = plugin.vault.hosts[host]
    print(`Enrollment: ${enrollment.name}`)
    print(`State directory: ${states[host]}`)
    const hosts: Host[] =
      host === 'pi'
        ? ['pi']
        : generation === 'both'
          ? ['opencode1', 'opencode2']
          : [generation === '1' ? 'opencode1' : 'opencode2']
    for (const target of hosts) {
      const providers = options.table.flatMap((entry) =>
        entry.hosts[target] ? [entry.hosts[target] as string] : [],
      )
      let reach: VaultGrantReach | undefined
      let withRows: ReadonlySet<string> | undefined
      if (discover) {
        const paths = hostEnrollmentPaths(enrollment.paths)
        const built = options.createCore({
          stateDir: states[host],
          tokenPath: paths.tokenPath,
          connect: () =>
            connectClaustrumScopedClient({ connectionFile, logger: () => {} }),
          isCustodyActive: async () =>
            (await enrollmentAuthority(paths, enrollment.name)) === 'vault',
          facts: {
            host: target,
            catalog: providers,
            ...(target === 'opencode2'
              ? {
                  integrations: Object.fromEntries(
                    providers.map((id) => [id, id]),
                  ),
                }
              : {}),
          },
        })
        try {
          await built.hub.refresh()
          reach = built.hub.grantReach()
          withRows = new Set(
            [...built.consumers]
              .filter(([, consumer]) => consumer.routingRows().length)
              .map(([id]) => id),
          )
        } catch {
          print(
            `${target}: vault discovery unavailable; activate after the vault is reachable.`,
          )
        } finally {
          await built.hub.dispose()
        }
      }
      let grantName = enrollment.name
      if (discover) {
        const status = await readClaustrumEnrollmentStatus(
          hostEnrollmentPaths(enrollment.paths),
          enrollment.name,
        )
        if (status.state === 'approved' && status.approvedName)
          grantName = status.approvedName
      }
      if (!reach || reach.grants === 0) {
        if (discover && !reach)
          print(
            'Grant reach is unknown; if access has not already been granted, use the grant command below.',
          )
        if (/^[a-z0-9][a-z0-9-]*$/u.test(grantName))
          print(
            `Grant command: ck auth grant --principal enrolled:${grantName} --selector-kind category --selector llm-provider --operation read`,
          )
        else
          print(
            'The vault approved a name that needs shell quoting. Use ck auth enroll list to find its principal, then grant category llm-provider with operation read.',
          )
      }
      if (reach && reach.grants > 0 && !withRows?.size)
        print(
          'The grant reaches no usable credentials. In the vault, check each credential is enabled, active and has an allowed auth method; the menu lists refused rows with the reason, including provider ids this plugin does not serve.',
        )
      const active = withRows?.size
        ? providers.filter((id) => withRows.has(id))
        : providers
      if (withRows && !withRows.size && providers.length)
        print(
          `${target}: no routable accounts yet; run the activation commands after granting usable credentials.`,
        )
      if (!providers.length) print(`${target}: no provider is available yet.`)
      if (target === 'opencode2') {
        for (const provider of active)
          print(`opencode auth login ${provider} --method ${vaultMethodId}`)
        if (!providers.length)
          print(
            `When a provider is available, replace <provider> in: opencode auth login <provider> --method ${vaultMethodId}`,
          )
      } else {
        print(
          `In ${target === 'pi' ? 'Pi' : 'OpenCode 1'}, type next${target === 'pi' ? ' (Pi asks consent before moving an existing login aside)' : ''}:`,
        )
        for (const provider of active) print(`${command} use ${provider}`)
        if (!providers.length) print(`${command} use <provider>`)
      }
    }
  }

  const result = await runSetup(plugin, setupArgv, io)
  if (result.hosts.length && result.mode !== 'claustrum')
    throw new Error(vaultOnlyMessage)
  if (result.dryRun && result.mode === 'claustrum') {
    const explicit = setupArgv
      .find((arg) => arg.startsWith('--opencode='))
      ?.split('=')[1]
    const generation =
      explicit === '1' || explicit === '2' || explicit === 'both'
        ? explicit
        : result.detection.opencode.generation === '2'
          ? '2'
          : '1'
    for (const host of result.hosts) await guidance(host, generation, false)
  }
  return result
}
