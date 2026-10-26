// The fixture world most real-Pi tests share: models.json providers whose
// models each pick a mock scenario, a user's own logins in auth.json, and a
// fake vault with rows for them.
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  type AgentOptions,
  agentDir,
  fakeVault,
  mockProvider,
  type PiOptions,
  placeholderOf,
  provider,
  readAuth,
  startPi,
  until,
} from './harness.ts'

export const redirectCodes = [301, 302, 303, 307, 308] as const
export const fillers = Array.from(
  { length: 9 },
  (_, index) => `fixture-n${index + 1}`,
)

export function fixtureModels(origin: string, second: string) {
  return {
    'fixture-a': provider(origin, [
      { id: 'ok', scenario: 'ok' },
      { id: 'first429', scenario: 'first429' },
      { id: 'all429', scenario: 'all429' },
      { id: 'all401', scenario: 'all401' },
      { id: 'echo', scenario: 'echo' },
      { id: 'echosse', scenario: 'echosse' },
      { id: 'reset', scenario: 'reset' },
      { id: 'elsewhere', baseUrl: `${second}/ok/v1` },
      ...redirectCodes.map((code) => ({
        id: `redirect-${code}`,
        scenario: `redirect/${code}`,
      })),
      ...redirectCodes.map((code) => ({
        id: `same-${code}`,
        scenario: `same/${code}`,
      })),
    ]),
    'fixture-b': provider(origin, [
      { id: 'b1', baseUrl: `${origin}/client/v4/accounts/listed-acct/v1` },
    ]),
    'fixture-c': provider(origin, [
      { id: 'c-chat' },
      { id: 'c-messages', api: 'anthropic-messages' },
    ]),
    // A reachable misplacement: a bearer model whose configured headers also
    // carry the placeholder in x-api-key.
    'fixture-p': provider(origin, [
      { id: 'p1', headers: { 'x-api-key': placeholderOf('fixture-p') } },
    ]),
    ...Object.fromEntries(
      fillers.map((id) => [id, provider(origin, [{ id: 'n' }])]),
    ),
  }
}

/** Every fixture provider starts with the user's own Pi login. */
export const userLogins = Object.fromEntries(
  ['fixture-a', 'fixture-b', 'fixture-c', 'fixture-p', ...fillers].map((id) => [
    id,
    { type: 'api_key', key: `user-key-${id}` },
  ]),
)

// Hand-formatted on purpose: release must restore these bytes exactly, not
// an equivalent JSON value.
export function userAuthText(logins: Record<string, unknown> = userLogins) {
  const lines = Object.entries(logins).map(
    ([id, entry]) => `  "${id}" :  ${JSON.stringify(entry)}`,
  )
  return `{\n${lines.join(',\n')}\n}\n`
}

export interface WorldOptions extends Omit<AgentOptions, 'models'> {
  rows?: ScopedInventoryRow[]
  confirm?: boolean
  pi?: Partial<PiOptions>
  authText?: string
}

export async function world(options: WorldOptions = {}) {
  const mock = await mockProvider()
  const vault = await fakeVault(options.rows ?? [])
  const agent = await agentDir({
    ...options,
    models: fixtureModels(mock.origin, mock.secondOrigin),
    auth:
      options.authText === undefined ? (options.auth ?? userLogins) : undefined,
  })
  if (options.authText !== undefined)
    await Bun.write(agent.authPath, options.authText)
  const launch = (extra: Partial<PiOptions> = {}) =>
    startPi({
      agent,
      mock,
      vault,
      confirm: options.confirm ?? true,
      ...options.pi,
      ...extra,
    })
  return { mock, vault, agent, launch }
}

export async function slotKey(authPath: string, providerId: string) {
  return (await readAuth(authPath))[providerId]?.key
}

export function waitForPlaceholder(authPath: string, providerId: string) {
  return until(
    async () =>
      (await slotKey(authPath, providerId)) === placeholderOf(providerId),
  )
}
