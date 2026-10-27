# claustrum-auth

Serve credentials from a [Claustrum](https://github.com/cortexkit/claustrum) vault to OpenCode 1, OpenCode 2 and Pi, for providers that need no special request handling.

Work in progress: nothing is published yet. The design is tracked in [cortexkit/common-auth#5](https://github.com/cortexkit/common-auth/issues/5).

## Setup and activation

The claustrum-auth plugin is vault-only. Enrollment and grants belong to
`ck auth`; provider activation happens inside the host, not in setup.
No real provider is enabled yet. Setup previews show the generic activation
form until a provider has passed its host's support checks.

Once published, preview the setup plan without changing the profile:

```sh
npx @cortexkit/opencode-claustrum-auth setup --dry-run --opencode=both
```

Quit OpenCode and Pi, then run the same command with `--yes` instead of
`--dry-run`. Setup uses common-auth's host detection, stopped-process fence,
enrollment ceremony and registration. Vault mode is always enabled;
`--claustrum` is accepted for compatibility and `--no-claustrum` is refused.
`--host opencode` or `--host pi` limits the run (the equals form also works);
`--enroll-only` skips host registration. Use `--help` to list supported flags.
Approve each host's separate
enrollment in `ck auth`. Setup prints the exact grant command and resolved
state paths; enrollment alone does not grant credential access.

After granting access, run each printed activation command. OpenCode 1 and Pi
use `/claustrum use <provider>` inside the host. Pi asks consent before moving
an existing login aside. OpenCode 2 uses
`opencode auth login <provider> --method claustrum-auth`. Setup never writes
host credentials or starts a host server.

## Text menu

`/claustrum` displays vault authority, reachability, watch mode and outage
receipts; provider ownership; accounts in routing order; the latest request
placement/origin refusal; and refused vault rows with their classification
codes. Pi also reports models hidden by the owned provider form.

- `/claustrum status`, `/claustrum accounts`, `/claustrum refusals`: focused views.
- `/claustrum reorder <provider> <route-id> ...`: include every route id from
  the accounts view exactly once, in the desired order, including inactive
  accounts. This changes the vault roster's routing preference, not credentials.
- `/claustrum use <provider>` and `/claustrum release <provider>`: OpenCode 1
  and Pi activation/release through their existing ownership safeguards.

There are no local account-writing actions, quota display or TUI entry.
