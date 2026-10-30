# Troubleshooting

Start with `/claustrum status`, `/claustrum accounts` and
`/claustrum refusals` inside the host. The menu distinguishes vault
reachability, provider ownership, refused vault rows and the latest request
refusal. Pi also lists models hidden by the owned provider form.

Do not paste keys or unredacted provider responses into an issue. The status
and refusal views are more useful than copying credential material.

## Setup or activation did not take effect

- Quit the hosts before running setup. Use `--dry-run` to inspect the plan and
  `--help` to see accepted flags.
- `This plugin serves vault keys only.` means setup received
  `--no-claustrum` or `--login`. Remove the flag; the plugin has no local-login
  mode.
- Enrollment alone is not a grant. Run the exact approval and grant commands
  printed by setup for the host you are using, then activate the provider
  inside that host. See [setup and activation](setup.md).
- Use host provider ids, not display names or model ids. For example, Kimi
  Code is `kimi-code-plan-global` on OpenCode and `kimi-coding` on Pi.

## A vault row is refused

`/claustrum refusals` reports classification codes. Common cases:

| Code | Meaning and next step |
| --- | --- |
| `unmapped` | No allowlist mapping matches the row. Check its provider metadata; the special Cline Pass row must be exactly `apikey:cline-pass` with no provider ids. |
| `unsupported-provider` | A provider id is outside the shipped table. Do not substitute a similar-looking host or model id. |
| `mixed-services` | The row names more than one service, or mixes a known id with an unknown one. Correct the row's provider metadata in the vault. |
| `reserved-provider` | The provider belongs to a dedicated plugin. Use openai-auth, anthropic-auth or antigravity-auth as appropriate. |
| `not-on-this-host` | The table does not offer that provider on this host. Check the [availability list](../README.md#supported-providers). |
| `unknown-to-host` | The catalog used for classification does not know the provider. OpenCode 2 reports this for Typesafe; OpenCode 1 uses the allowlist as its catalog stand-in, but the checked host catalog still has no Typesafe models. |
| `integration-mismatch` | OpenCode 2's integration id differs from the provider id. The plugin refuses that mapping rather than guessing. |

Rows also need an explicit auth method and must be enabled and active in the
vault. Do not infer an auth method from a credential id or refresh adapter.
See [the operator's vault rows](providers.md#the-operators-vault-rows).

## A model is missing

Pi hides models outside the provider's selected bearer API while the plugin
owns that provider. OpenCode can list models whose drivers use `x-api-key` or
`x-goog-api-key`, but the plugin refuses those requests. Choose a bearer model
from [provider details](providers.md#opencode-go-and-opencode-zen-bearer-models-only);
do not move the key to a different header to bypass the refusal.

OpenCode Zen is not offered on OpenCode 2. xAI uses WebSocket by default on
OpenCode 2, with guarded HTTP fallback; see
[xAI on OpenCode 2](providers.md#xai-on-opencode-2) for the transport and voice
limits.

## A request is refused before sending

The wording differs by host. These examples use concrete provider ids; the
message substitutes the provider, header or allowed origins for the request.

### Wrong origin or credential placement

On OpenCode 1, a changed base URL can produce:

> claustrum-auth: the vault key for deepseek is only sent to the provider's own origins; this request goes elsewhere (check provider.deepseek.options.baseURL).

Restore the provider's documented API origin. Another scheme, port, subdomain
or proxy is not admitted just because the provider name matches.

On OpenCode 2, a non-bearer model can produce:

> claustrum-auth plugin: this model's driver sends its key for opencode-go in x-api-key; the claustrum-auth plugin only serves keys sent in Authorization.

Choose an eligible bearer model instead. If the message says the request
carries the key in more than one header, remove the extra credential carrier;
the plugin requires Authorization alone.

A wrong-origin xAI handshake on OpenCode 2 reports:

> claustrum-auth plugin: the vault key for xai is only sent over WebSocket to wss://api.x.ai; this connection goes to another origin, so it was not opened.

The host can wrap the refusal in its own stream error. Do not disable the
origin check to make a custom endpoint work.

Pi returns a local 400 response for a refused request. For example:

> Request refused locally by the claustrum-auth plugin: this model's request carries the deepseek vault placeholder outside the Authorization header, and vault keys are only sent as Authorization: Bearer. Nothing was sent.

### Vault unavailable, no account or a changed account

OpenCode 2 distinguishes these cases:

> claustrum-auth plugin: no vault account for deepseek. Grant one with ck auth, then try again.

> claustrum-auth plugin: the Claustrum vault could not be reached, so deepseek was not sent. Start the vault, or switch deepseek back to your own key.

> claustrum-auth plugin: the Claustrum vault no longer serves this account for deepseek; it was disabled, removed or changed after the plugin read it. Nothing was sent. Sign in with "Claustrum vault (claustrum-auth plugin)" again to pick up the vault's current accounts, or switch deepseek back to your own key.

Check vault reachability first, then the host's enrollment, grant and the
row's current enabled/active state. If the account changed, repeat the host's
activation flow so it picks up the current roster. Do not re-enroll every
time a provider request fails.

## A provider still uses another login

On OpenCode 1, an existing effective key in stored auth, config or the
environment prevents vault activation. The refusal identifies the source and
the action to take. For a stored key:

> claustrum-auth: deepseek uses your own stored key; the vault key is not used until you remove it (opencode auth logout deepseek), then run /claustrum use deepseek again.

Remove the identified key only if you intend to switch owners. Avoid concurrent
OpenCode 1 auth writes: its auth-file rewrite is not an atomic transaction
with another host process.

On Pi, declining the consent prompt reports:

> Your Pi login for deepseek was not moved. Nothing changed.

Run `/claustrum use deepseek` again only if you want the plugin to move that
login aside. `/claustrum release deepseek` restores the saved login when the
ownership checks permit it.

## Account reordering is refused

> claustrum-auth: order refused; include every route id exactly once, in the desired order.

Copy the full route-id list from `/claustrum accounts`, including inactive
accounts, without omissions or duplicates. If the response is instead
`claustrum-auth: vault mode is off or unreadable; no order was changed.`,
restore vault mode or resolve the enrollment-state read failure before trying
again. See [commands](commands.md#change-account-order).
