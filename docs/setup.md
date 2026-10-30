# Setup and activation

The claustrum-auth plugin is vault-only. Enrollment and grants belong to
`ck auth`; provider activation happens inside the host, not in setup. It does
not offer local sign-in or a local API-key store.

## Preview or run setup

Quit OpenCode and Pi before making changes. The setup command is supplied by
the OpenCode package and can register either public package:

```sh
npx @cortexkit/opencode-claustrum-auth setup
```

To preview setup without changing the host profile:

```sh
npx @cortexkit/opencode-claustrum-auth setup --dry-run --opencode=both
```

Run the same command with `--yes` instead of `--dry-run` to apply the plan.
Setup uses common-auth's host detection, stopped-process fence, enrollment
ceremony and registration. It never writes host credentials or starts a host
server.

Useful flags:

- `--host opencode` or `--host pi`: limit setup to one host family (the equals
  form also works).
- `--opencode=1`, `--opencode=2` or `--opencode=both`: select OpenCode versions.
- `--enroll-only`: enroll without registering a host plugin.
- `--help`: print the supported flags without running setup.

Vault mode is always on. `--claustrum` is accepted for compatibility;
`--no-claustrum` and `--login` are refused with
`This plugin serves vault keys only.`

## Approve enrollment and grant access

Approve each host's separate enrollment in `ck auth`. Setup prints the exact
approval and grant commands and the resolved state paths. Enrollment alone
does not grant credential access: follow the printed grant command for the
`llm-provider` category before activating a provider.

OpenCode and Pi use separate enrolled principals. A successful enrollment or
grant for one is not a grant for the other. Keep credential creation and
login refresh in the vault; the plugin consumes the served keys.

## Activate in the host

After granting access, start the host and run the activation command printed
by setup. Provider ids can differ across hosts; use the
[provider list](../README.md#supported-providers), not the display name or a
model id.

| Host | Activation |
| --- | --- |
| OpenCode 1 | `/claustrum use <provider>` inside OpenCode |
| OpenCode 2 | `opencode auth login <provider> --method claustrum-auth` |
| Pi | `/claustrum use <provider>` inside Pi |

For example, Kimi Code is `kimi-code-plan-global` on OpenCode and
`kimi-coding` on Pi. Serving a turn requires a model in the host's catalog and
the plugin's provider and request checks to pass.

Pi asks for consent before moving an existing login aside. Activation and
release preserve the host's ownership safeguards; they are not commands to
overwrite another plugin's credentials. See [commands](commands.md) and
[troubleshooting](troubleshooting.md) for ownership refusals.

## Check the result

Run `/claustrum status` and `/claustrum accounts` inside the host. Confirm
vault reachability, provider ownership and the accounts available for routing.
Use `/claustrum refusals` for rows the plugin cannot serve. See
[provider metadata](providers.md#the-operators-vault-rows) if a row is refused
despite a successful grant.
