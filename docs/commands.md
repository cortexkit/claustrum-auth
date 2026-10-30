# The /claustrum menu

Run `/claustrum` inside OpenCode or Pi for the text menu. It shows:

- Whether vault mode is on and whether the vault can be reached.
- How credential discovery is watching for changes, and whether retained
  credentials are active for use during a vault outage.
- Provider ownership and accounts in routing order.
- The latest request placement or origin refusal.
- Refused vault rows with their classification codes.
- On Pi, models hidden by the owned provider form.

There are no local account-writing actions, quota display or interactive
terminal user interface. Use the vault to manage credentials; use this menu to
inspect routing and host ownership.

`Watch` is the discovery state, not vault reachability: `watching` means a
watch is open, `polling` means no watch is open yet, and `fallback` means a
watch is unavailable and discovery is polling instead. The `Outage receipts`
field is `active` when at least one usable, previously authorized credential
retained in memory is marked for use during a vault outage; `none` means none
is active. It is a host-wide summary, not an account count.

## Focused views

| Command | View |
| --- | --- |
| `/claustrum status` | Vault and provider status |
| `/claustrum accounts` | Accounts in routing order, including route ids |
| `/claustrum refusals` | Refused vault rows and the count left to other plugins |

## Change account order

```text
/claustrum reorder <provider> <route-id> ...
```

Copy every route id for that provider from the accounts view exactly once,
including inactive accounts, in the desired order. This changes the vault
roster's routing preference, not the credentials. Do not substitute account
labels or credential ids for route ids.

## Activate or release a provider

On OpenCode 1 and Pi:

```text
/claustrum use <provider>
/claustrum release <provider>
```

Use the host's provider id from the [provider list](../README.md#supported-providers).
Pi asks for consent before moving an existing login aside. The ownership
checks prevent a release from removing credentials that another owner has
written since activation.

On OpenCode 1, do not run login or logout concurrently with `use` or `release`:
the host rewrites the whole auth file, so a login during that write can be
lost. Ownership checks are not an atomic transaction across host processes.

On OpenCode 2, activate through its auth command instead:

```sh
opencode auth login <provider> --method claustrum-auth
```

See [setup and activation](setup.md) for enrollment and grants, and
[troubleshooting](troubleshooting.md) for refusal messages.
