# The claustrum-auth plugin on OpenCode 2

The package `@cortexkit/opencode-claustrum-auth` has two entries. OpenCode 2
loads `./server`; OpenCode 1 loads the root entry. Registering the package
once under the `plugin` key in `opencode.json` serves both hosts.

## What it does at start

For every provider in its supported table (`docs/providers.md` lists the live
ones and where each id and origin comes from; a provider is listed only after
its own proof on each host), the plugin registers:

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

## Plugin state

OpenCode 2 and OpenCode 1 share the enrollment `claustrum-auth-opencode` and
the same state folder, outside OpenCode's watched configuration folder. With
the default config folder (`<home>/.config/opencode`), the default state paths
are:

| OS | Default state folder |
| --- | --- |
| Linux | `~/.local/state/cortexkit/claustrum-auth/opencode/` |
| macOS | `~/.local/state/cortexkit/claustrum-auth/opencode/` |
| Windows | `%USERPROFILE%\.local\state\cortexkit\claustrum-auth\opencode\` |

On every OS, `XDG_STATE_HOME` replaces `~/.local/state` when set. A different
config folder (from `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME/opencode`) uses
`opencode-<hash>` instead of `opencode`, where `<hash>` is the first 16 hex
characters of SHA-256 of the config folder's native realpath (or its resolved
path if it does not exist), without case folding. The default config folder
is determined from the home directory, not `XDG_CONFIG_HOME`.
Paths that resolve to the same real config folder share state, including
aliases of the default folder.

The state folder holds the enrollment token and state, rosters, activation
flags and an owner-only `config-dir.json` binding it to the config folder's
identity. The plugin refuses a binding for another config folder rather than
sharing its state. It writes no plugin runtime files under OpenCode's config
folder. No old state is migrated.

## Tests

- `packages/opencode/test/v2/server.test.ts`: the entry against a fake host
  and a fake vault.
- `packages/opencode/test/v2/e2e/opencode2.e2e.test.ts`: the real pinned
  `@opencode/cli` against a loopback mock provider and a fake vault. It runs
  only with `CLAUSTRUM_AUTH_OPENCODE2_E2E=1` (the `opencode2-e2e` CI job, on
  Linux, macOS and Windows) because it installs the CLI with npm.
  `CLAUSTRUM_AUTH_OPENCODE2_E2E_CLI_DIR` may point at an existing install.

### Real-host startup diagnostics

The fixture bundle uses the production runtime externals. Linux and macOS
use a `node_modules` link to the installed dependencies. Windows uses real
directories containing copies of the installed external packages and their
production dependencies, not a junction. Each package is located through the
resolver from its importer, so copying does not assume dependencies live in
the workspace package's own `node_modules` rather than a hoisted location.
Copies retain the installed versions without a second registry install.
The real-directory layout is also tested on POSIX, in a path with spaces and
a tilde, including transitive imports and byte-for-byte native prebuilds.
The probe uses filesystem-directory parents for resolution and loads the
externals in a separate Bun process. Bun 1.4.2 can fail an explicit-parent
lookup using a percent-encoded file URL even when the dependency folders are
real, so a URL-based resolver assertion alone cannot diagnose a broken link.

In particular,
`@cortexkit/private-files` must keep its package layout: its Windows loader
finds `../prebuilds/*.node` relative to its own `import.meta.url`. Inlining
that loader into the scratch plugin relocates the lookup to a nonexistent
scratch `prebuilds` directory. POSIX private writes do not load that addon,
so a fully inlined fixture can pass on Linux and macOS but fail before
registering any login method on Windows. The published build already keeps
these dependencies external.

On a failed scenario the harness prints the exact `opencode.json`, the plugin
folder's recursive file list (excluding dependency contents), the plugin's
`node_modules` listing including scoped packages, directory/link types and
link targets, native realpaths alongside the supplied paths, and the full
stdout and stderr of every host process, including servers from
before a restart. The server runs with debug logging; startup loader errors
are not truncated to the last requests. The fixture also records import,
setup and enrollment-token stages, and rethrows setup errors after recording
their message, stack, cause and native security fields. A missing login method
can therefore be traced back to import resolution or the specific setup
refusal rather than inferred from an empty plugin log.
