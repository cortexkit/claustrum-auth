# Architecture

claustrum-auth serves API keys from the Claustrum vault to OpenCode and Pi, for the LLM providers that need nothing beyond a bearer key: DeepSeek, Cerebras, OpenRouter, xAI and the others in `docs/providers.md`. The user keeps no key in the host: the host holds a placeholder, and every request the plugin owns gets a key the vault serves for that one send. Requests that carry the user's own key pass through untouched.

It ships as two npm packages built from one core:

- `@cortexkit/opencode-claustrum-auth` (`packages/opencode`): the OpenCode 1 entry (package root), the OpenCode 2 entry (`./server`), and the `claustrum-auth` setup command.
- `@cortexkit/pi-claustrum-auth` (`packages/pi`): the Pi extension.
- `@cortexkit/claustrum-auth-core` (`packages/core`): private, bundled into both.

The plugin is built on `@cortexkit/common-auth` (bundled): its Claustrum consumer and discovery hub, routing, limit policy, OpenCode 2 installer, Pi slot handling, setup and redaction. `@cortexkit/claustrum-client`, `@cortexkit/subc-client` and `@cortexkit/private-files` stay external, one copy per install. Providers with their own CortexKit plugin (OpenAI, Anthropic, Google) are never served here.

Paths below are relative to the repository root.

## Terms

- **Vault, enrollment:** the Claustrum vault holds the keys. A host enrolls once (`claustrum-auth-opencode`, shared by OpenCode 1 and 2, or `claustrum-auth-pi`), and an operator grants it the `llm-provider` category.
- **Service, provider table:** a service is one provider the plugin serves. `supportedProviders` (`packages/core/src/providers.ts`) lists each service's fleet ids, its id on each host, its allowed origins and its key placement.
- **Fleet id, host id:** a vault row names its service by fleet id (`provider_ids`); each host knows the same service by its own id. The table maps one to the other.
- **Row classification:** for each vault row, `mine` (this plugin serves it, on this host, under this provider), `not-mine` (a dedicated plugin's row) or `refused` with a fixed code.
- **Route:** a vault account as a routing row. It holds no key.
- **Placeholder:** the fixed non-secret value the host stores for a provider so its requests come to the plugin. It is never sent.
- **Owned request:** a request carrying the placeholder as `Authorization: Bearer`. Only owned requests are served.
- **Activation:** making a provider the plugin's: storing the placeholder in the host. **Release** is the reverse.
- **Shadowed:** a placeholder is stored, but the host would use the user's own key instead (an environment variable, for example).
- **Hub:** common-auth's discovery hub: one vault connection, one watch and one list per process for every provider.
- **Hosted mode:** Thalamus started the host with `CORTEXKIT_VAULT_HOST=thalamus` and provides the vault connection.

## Code map

| Area | Where | Role |
|---|---|---|
| Provider table | `packages/core/src/providers.ts` | Served services, fleet and host ids, origins, reserved providers, row classification. |
| Placement | `packages/core/src/placement.ts` | Ownership and placement checks, origin checks, refusal codes, error and response scrubbing. |
| Serving | `packages/core/src/fetch.ts`, `serving.ts` | One owned request: route choice, vault send, redirects, limits, scrubbing. |
| Limits | `packages/core/src/limits.ts`, `balance.ts` | The shared limit policy, and which 402s mean an empty balance. |
| Runtime | `packages/core/src/runtime.ts` | Builds the hub and its members from the table for one host. |
| Activation | `packages/core/src/activation.ts` | The state machine for activating and releasing a provider. |
| Menu, startup | `packages/core/src/menu.ts`, `startup.ts` | `/claustrum` text; startup errors with fixed labels only. |
| OpenCode 1 | `packages/opencode/src/v1/` | Config hook, per-provider fetch, `auth.json` placeholder, shadow check, `/claustrum use` and `release`. |
| OpenCode 2 | `packages/opencode/src/v2/` | Vault login method per provider, common-auth installer adapter, handshake and frame hooks. |
| Setup, state | `packages/opencode/src/setup.ts`, `setup-bin.ts`, `state-dir.ts` | The `claustrum-auth setup` command; where OpenCode state lives. |
| Pi | `packages/pi/src/` | Provider registration, consent, slot swap, model lists, serving. |

`STRUCTURE.md` has the file map. User documentation is in `docs/` (setup, commands, each host, providers, security, troubleshooting).

## Which rows the plugin serves

`classifyRow` runs on every vault row the enrollment can see:

1. A row with no `authMethod` is refused (`no-auth-method`); a row with no provider ids is refused (`unmapped`).
2. ChatGPT, Antigravity and Anthropic OAuth rows are `not-mine`: their dedicated plugins serve them.
3. The row's fleet ids must all belong to one table entry. A reserved provider id (`openai`, `openai-codex`, `anthropic`, `anthropic-platform`, `google`) refuses the row, an unknown id refuses it (`unsupported-provider`), and ids of two services refuse it (`mixed-services`), because a 401 on such a row couldn't be attributed. A row with an empty id list matches only an exact credential id in the table (`apikey:cline-pass`), never a prefix.
4. The entry must have an id on this host, and the host's catalog must carry that id. On OpenCode 2 the provider must also sit under the host integration of the same id, so the placeholder is stored where the plugin's login method lives.

Fleet ids the table doesn't know are refused rather than guessed, so a vault owner never has to retag rows for this plugin. A service is added to the table only after each host proved its key placement, origin and redirect refusal, error scrubbing and a real request (sources and proof in `docs/providers.md`).

## Serving one request

`createFetch` (`packages/core/src/fetch.ts`) serves an owned request on every host:

1. **Ownership and placement first, before any vault read.** The placeholder must appear exactly once, as `Authorization: Bearer <placeholder>`; anywhere else, or more than once, refuses (`placement-refused`). A request without it is foreign and passed on untouched.
2. **Origin.** The URL's scheme, host and port must match one of the entry's origins, with no user or password in the URL; a `baseURL` override to another origin refuses (`origin-refused`). The body is capped at 64 MiB.
3. **Route.** The shared limit decision picks the next admitted vault account in roster order.
4. **Send.** `consumer.send` asks the vault for a key for this send and the plugin puts it only into `Authorization: Bearer`. Redirects are handled manually: only a same-origin redirect is followed, rechecked against the origins, at most five times; a cross-origin redirect, or one whose address contains the served key, is returned unfollowed.
5. **After the reply.** A limit reply may move the request to the next account (see Several accounts). Every response is scrubbed of each key served for it, in bodies, streamed error events and headers, before the host sees it.

Every key placement on every host is a bearer header; all served entries are class A. The table also defines classes for keys placed with an account in the URL path (B) and for other placements (C, D, always refused); none ship.

## Several accounts

Accounts are tried in roster order, which the user can change with `/claustrum reorder`. The plugin adopts common-auth's shared limit policy (`packages/core/src/limits.ts`):

- **Rate limits:** a 429 sets the account aside for 60 seconds, or for a finite `Retry-After`.
- **Empty balance:** a 402 counts only where the provider documents it as an empty balance (`packages/core/src/balance.ts`): any DeepSeek 402, and an OpenRouter 402 for account credits. That sets the account aside for five minutes. Other 402s (OpenRouter key or request budgets, for example) stay with the user and mark nothing, because moving them would spend another key's money past a cap the user set.
- **Recovery:** when every account is set aside, a fresh request tries the first one again, so a topped-up account recovers without a restart. Only a success on a marked account writes recovery state, and clearing a balance mark never clears an active rate-limit mark.
- **Persistence:** marks live in the local vault roster, shared by every process using it. The limits state reloads when the vault's account list changes, so an account that arrives just after start is recognized.
- **401:** reported to the vault only for the key this host was served for that request.

## OpenCode 1

The config hook installs `options.fetch` on every served provider (`packages/opencode/src/v1/plugin.ts`); it serves owned requests and hands everything else to the fetch that was there before. OpenCode 1 runs the plugin once per project in one process, so instances with the same state share one hub through a process-wide registry.

- **Activation:** `/claustrum use <provider>` writes `{ type: 'api', key: 'cortexkit-claustrum-auth:v1:<provider>' }` into OpenCode's `auth.json`, only when the user has no key of their own for it (no stored login, none of the provider's environment variables, no `options.apiKey` in config). `/claustrum release <provider>` removes the entry only if it is exactly the placeholder. Both take effect at the next start. OpenCode 1 rewrites `auth.json` without compare-and-set, so the plugin re-reads before and after its write and never overwrites a key it saw.
- **Shadowing:** if one of the provider's environment variables is set while the placeholder is stored, the placeholder hides the user's key. Owned requests are then refused locally with a message naming the fix (release the provider, or remove the variable), so the plugin never serves from the vault while a user's key is hidden. Variable names are matched exactly, as OpenCode 1 matches them.
- **Released providers:** a persisted `released` flag per provider keeps anything automatic from re-entering it; only `/claustrum use` clears it.
- Command hooks can't finish without a model turn on OpenCode 1, so a handled `/claustrum` command ends with a fixed error.

## OpenCode 2

At start, every served provider gets a login method, **Claustrum vault (claustrum-auth plugin)**, and an installation of common-auth's OpenCode 2 installer that acts only on requests whose active credential is the plugin's placeholder (`gateOnPlaceholder` in `packages/opencode/src/v2/setup.ts`). Both are registered whether or not the vault answers, so a provider can be activated later without a restart. The hub is built on first use, because the host sets plugins up before it applies the configuration's providers, and classification depends on the catalog.

- **Activation:** `opencode auth login <provider>`, choosing the vault method. The login succeeds only if the host is in vault mode, the vault answers, and it serves at least one account for the provider; then the host stores the placeholder. Signing in with the user's own key releases the provider, and nothing switches it back.
- **Hooks:** `packages/opencode/src/v2/adapter.ts` answers the installer. An owned WebSocket handshake's origin is checked against the entry's separate `wss` origins before any account is chosen (only xAI has any), and frames are scrubbed before the host's driver reads them.
- **Mixed sessions:** a session that used both a vault key and another credential for a provider keeps the host's own retry decisions for its lifetime.
- **Redirects:** the host's HTTP transport follows redirects itself, because OpenCode 2.2 drops the plugin's manual redirect setting ([OpenCode issue #61272](https://github.com/anomalyco/opencode/issues/61272)). A cross-origin redirect then reaches the other origin without the `Authorization` header, but a key placed in the redirect address would reach it. Only an allowlisted provider, which already holds the key, can send one.

OpenCode 1 and 2 share the enrollment and one state folder outside OpenCode's watched config folder: `$XDG_STATE_HOME/cortexkit/claustrum-auth/opencode/` (default `~/.local/state`) for the config folder `~/.config/opencode`, and `opencode-<16 hex>/` (from the config folder's real path) for any other (`packages/opencode/src/state-dir.ts`). A `config-dir.json` in each folder binds it to its config folder, and a folder bound to another is refused. `OPENCODE_CLAUSTRUM_AUTH_STATE_DIR` names an exact folder instead, for hosts that must share one enrollment.

## Pi

The extension registers each served provider in Pi (`packages/pi/src/extension.ts`). Outside vault mode, Pi's own login for a provider keeps serving it, and a provider the plugin held is handed back.

- **Entering:** in vault mode, a provider the vault serves is taken over automatically, after the user consents once per provider. common-auth's Pi slot moves Pi's own login for it aside and stores a placeholder API key, restored byte-for-byte on release.
- **Models:** an owned registration replaces the provider's model list with the models of its one bearer API (`openai-completions` or `openai-responses`), exactly as Pi composed them; models of any other API would send the placeholder somewhere the plugin can't serve. To restore Pi's own list, the extension unregisters and registers again, because Pi merges a re-registration over the previous one.
- **Serving:** only the plugin's own placeholder is owned; a user's key goes to pi-ai as Pi resolved it. Refusals are answered with a local response, so neither the OpenAI SDK nor Pi retries them as connection failures.
- One queue runs every slot change, registration and registry refresh in the process, so providers never contend for Pi's `auth.json` lock.

Pi's state lives in `<Pi agent folder>/claustrum-auth/` (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).

## Setup and hosted mode

`claustrum-auth setup` (`packages/opencode/src/setup.ts`, over common-auth's setup) registers the plugin in OpenCode and Pi and enrolls with the vault. It always takes the vault path: there is no local sign-in to set up. It prints the commands an operator runs in `ck`, CortexKit's command line, to approve the enrollment and grant `llm-provider`.

In hosted mode (`CORTEXKIT_VAULT_HOST=thalamus`), the hub connects through the client Thalamus provides instead of an enrollment of its own. An owned request never falls back to the user's own key, and a request already carrying the user's key still passes through untouched.

## Load-bearing invariants

1. **Check before reading the vault.** Ownership, placement and origin are checked before any vault read, and the origin again before each send.
2. **The key goes only into `Authorization: Bearer`,** only to an allowlisted origin, and never into a URL.
3. **The user's own key wins.** The plugin never overwrites a user's key, never serves while one is shadowed, and passes foreign requests through untouched.
4. **Rows are classified, never guessed.** Unknown fleet ids, mixed services and reserved providers are refused; dedicated plugins' rows are left to them.
5. **No served key in anything the host sees:** response bodies, streamed errors, headers, error messages and startup errors are scrubbed, and every refusal and status text is fixed.
6. **Only documented empty-balance 402s move a request.** Every other 402 stays with the user.
7. **No automatic re-entry after release.** A released provider returns only on an explicit `/claustrum use` or vault login.

## Failure handling

- **Vault unreachable:** common-auth's consumer keeps the last key the vault served each account, in memory only, and serves it until it expires; then owned requests are refused locally. An unreachable vault leaves the last committed roster in place.
- **No vault account for a provider:** owned requests are refused locally with a fixed message that says whether vault mode is off, the vault serves no account, or the roster couldn't be saved.
- **All accounts set aside:** a fresh request probes the first one.
- **Startup failure:** the host gets a fixed label and a known filesystem code only (`packages/core/src/startup.ts`).

## Development

Unit tests live in each package's `test/`; repository tests (packaging, release, discovery) in `test/`. Real-host suites run real OpenCode 1, OpenCode 2 and Pi against a fake vault (`packages/opencode/test/opencode1.e2e.test.ts`, `packages/opencode/test/v2/e2e/`, `packages/pi/test/*.e2e.test.ts`). CI (`.github/workflows/ci.yml`) runs the unit, setup-menu and real-host suites on Linux, macOS and Windows, and Windows owner-only file checks on two Windows versions. `scripts/gate.sh --fast` runs the quick checks. `docs/live-smoke.md` describes the gated run against the real vault. Releases are tag-driven through `scripts/release.sh` and `release.yaml`.
