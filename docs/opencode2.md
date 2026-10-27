# The claustrum-auth plugin on OpenCode 2

The package `@cortexkit/opencode-claustrum-auth` has two entries. OpenCode 2
loads `./server`; OpenCode 1 loads the root entry. Registering the package
once under the `plugin` key in `opencode.json` serves both hosts.

## What it does at start

For every provider in its supported table (none are live yet; each provider
is listed only after its own proof on each host), the plugin registers:

- a login method, **Claustrum vault (claustrum-auth plugin)**, under the
  provider's own integration;
- a gated installation of common-auth's OpenCode 2 installer for that
  provider.

Both are registered whether or not the vault answers, so a provider can be
activated once the vault is reachable, without a restart. The plugin never
adds a provider to the host's catalog, and it never touches a provider that
belongs to a dedicated plugin (`openai`, `anthropic`, `google` and the rest
of the reserved list).

## Activating a provider

Run `opencode auth login <provider>` and choose the Claustrum vault method.
The plugin checks, in order, that this host is in vault mode, that the vault
answers, and that the vault serves at least one account for the provider. If
any check fails, the login fails with a message that names the fix, and the
host stores nothing. On success the host stores only a placeholder, which
marks later requests for that provider as the plugin's.

To stop using the vault for a provider, sign in to it with your own key.
Your key is then sent unchanged, and the plugin reads nothing from the vault
for it. Nothing switches it back automatically, not even a restart.

## Where a vault key goes

The plugin puts a vault key only into `Authorization: Bearer`, and only on a
request to one of the provider's allowed `https` origins. A request is refused
locally, with no vault read and nothing sent, when:

- the model's driver sends its key in another header (`x-api-key`, say), or
  the placeholder is in more than one header;
- the request goes to any other origin, for example because of a `baseURL`
  override in the configuration.

The served key is removed from error bodies, from streamed error events and
from response headers before the host sees them. The host's own transport
errors (a refused or reset connection) carry no request URL on OpenCode
2.0.32, which the real-host tests check.

## Several accounts

Accounts are tried in roster order. A 429 sets the account aside until its
`retry-after` (or for 60 seconds), and the host's retry moves the turn to the
next account before any output. A session that has used both the vault and
another credential for the same provider keeps the host's own retry decisions
for the rest of its life (common-auth's mixed-ownership rule). A 401 is
reported to the vault only for the key that this host was served for that
request.

## Tests

- `packages/opencode/test/v2/server.test.ts`: the entry against a fake host
  and a fake vault.
- `packages/opencode/test/v2/e2e/opencode2.e2e.test.ts`: the real pinned
  `@opencode/cli` against a loopback mock provider and a fake vault. It runs
  only with `CLAUSTRUM_AUTH_OPENCODE2_E2E=1` (the `opencode2-e2e` CI job, on
  Linux, macOS and Windows) because it installs the CLI with npm.
  `CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR` may point at an existing install.
