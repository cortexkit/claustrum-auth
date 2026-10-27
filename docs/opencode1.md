# OpenCode 1

The claustrum-auth plugin serves vault keys on OpenCode 1 through each served
provider's `options.fetch`, which its config hook installs at start. It owns a
request only when the request carries the provider's placeholder,
`cortexkit-claustrum-auth:v1:<provider>`, as `Authorization: Bearer`. Every
other request goes on unchanged, including any request that carries your own
key.

## Commands

- `/claustrum use <provider>` stores the placeholder for `<provider>` in
  OpenCode's `auth.json`. It does this only when you have no key of your own
  for that provider: no stored login, none of the provider's environment
  variables, and no `provider.<provider>.options.apiKey` in your config.
  Otherwise it refuses and tells you what to remove.
- `/claustrum release <provider>` stops using the vault for `<provider>`. It
  removes the stored entry only if that entry is exactly the plugin's
  placeholder.

Both take effect the next time OpenCode starts.

Do not run either command while you are logging in to any provider elsewhere.
OpenCode 1 rewrites the whole `auth.json` on every login and offers no
compare-and-set, so a login that lands at the same moment can be lost. The
plugin reads the entry again just before it writes, and never writes over a
key it saw there. It reads again after the write and reports a login that
changed the entry after its own write. It cannot see a login that its own
write replaced.

## When your own key is set later

If the placeholder is stored and one of the provider's environment variables
is set when OpenCode runs, the plugin refuses each request for that provider
locally. The error says that your key is shadowed and how to fix it: run
`/claustrum release <provider>` to use your key, or remove the variable to use
the vault. Variable names are matched exactly, as OpenCode 1 matches them, on
every OS.

## Plugin state

OpenCode 1 and OpenCode 2 share the enrollment `claustrum-auth-opencode` and
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

## Real-host tests

`packages/opencode/test/opencode1.e2e.test.ts` runs pinned OpenCode 1.19.3
against a loopback mock provider, with the fixture providers and a fake vault.
It covers serving, failover, the redirect proof, redaction, the shadow check
and `/claustrum use`/`release` under concurrent logins. It is skipped unless
`CLAUSTRUM_AUTH_OPENCODE1_E2E=1` is set:

```sh
CLAUSTRUM_AUTH_OPENCODE1_E2E=1 bun test packages/opencode/test/opencode1.e2e.test.ts --timeout 600000
```

The first run installs `opencode-ai@1.19.3` with npm into
`target/opencode1-host`. Set `CLAUSTRUM_AUTH_OPENCODE1_DIR` to use an existing
install instead. CI runs the test on Linux, macOS and Windows in the
`opencode1-e2e` job.
