# Live smoke: a real vault key through each served provider

The design (section 14.4, step 6) asks for one operator-run smoke per provider
and host: a real turn against the provider, with a key served from the real
vault, on Windows and on macOS or Linux. CI cannot do this, because it needs a
vault key and an enrolled host, so this page is the script for the run.

Record the result in the provider batch's slice report: host, OS, provider,
the turn's output and the `/claustrum` status line.

For the operator-only headless equivalent, see
`.cortexkit/scripts/live-smoke/README.md` and run its `run.ts` with `--dry`
first. The local driver uses an already-enrolled scratch home, writes one
Markdown table per host, and leaves the personal-key checks below manual.
The entry and README there are local, git-ignored operator artifacts; the
shared driver is tracked at `scripts/live-smoke/run.ts` and can also be run
directly with the same arguments.

For each served row with an eligible catalog model, the headless driver attempts
at most one provider request, with a 16-token output cap. It excludes non-text
models, prefers an advertised reasoning-off variant
or a non-reasoning model, and otherwise selects the lowest advertised effort.
Within those groups it chooses the lowest catalog input-plus-output price.
OpenCode 2 selects variants with `provider/model#variant`; OpenCode 1 uses the
message's `variant` field, and Pi uses thinking level `off`. The guards block
both retries and automatic output-limit continuations before another physical
send. If the first response is still truncated, `RequestBudgetExhausted` is a
driver-budget failure, not an account refusal; it is not retried. The second
xAI turn and Anthropic refusal probes below remain manual checks, not extra
headless requests. Raw API captures keep their sequence across host restarts.

## 0. Once, before the first provider

1. Install the published packages, or a packed build of this branch:
   `@cortexkit/opencode-claustrum-auth` and `@cortexkit/pi-claustrum-auth`.
   The setup command is the `claustrum-auth` bin of the OpenCode package.
2. Run setup and approve the enrollment, then grant the category:

   ```sh
   npx @cortexkit/opencode-claustrum-auth setup --claustrum
   # approve with the `ck auth enroll approve` command setup prints
   ck auth grant --principal enrolled:claustrum-auth-opencode \
     --selector-kind category --selector llm-provider --operation read
   ck auth grant --principal enrolled:claustrum-auth-pi \
     --selector-kind category --selector llm-provider --operation read
   ```

   A dry run first shows the enrollment, the grant command and the activation
   lines without writing anything: add `--dry-run`.

3. Check that the vault serves the row you are about to use, and what the
   plugin makes of it, with the menu inside the host (step 1 of each provider
   below). `docs/providers.md` lists the rows each provider needs; rows carry
   the fleet's provider ids, which the plugin maps to each host's id.

## OpenCode 2

Command per provider (the method id is `claustrum-auth`):

| provider | activation |
| --- | --- |
| cerebras | `opencode auth login cerebras --method claustrum-auth` |
| deepseek | `opencode auth login deepseek --method claustrum-auth` |
| fireworks | `opencode auth login fireworks-ai --method claustrum-auth` |
| inception | `opencode auth login inception --method claustrum-auth` |
| cline-pass | `opencode auth login cline-pass --method claustrum-auth` |
| kimi-coding | `opencode auth login kimi-code-plan-global --method claustrum-auth` |
| openrouter | `opencode auth login openrouter --method claustrum-auth` |
| typesafe | `opencode auth login typesafe --method claustrum-auth` |
| meta | `opencode auth login meta --method claustrum-auth` |
| xai | `opencode auth login xai --method claustrum-auth` |
| opencode-go | `opencode auth login opencode-go --method claustrum-auth` |

opencode-zen is not served on OpenCode 2 (`docs/providers.md`): check in
step 1 that `/claustrum refusals` lists `apikey:opencode-zen` as
`not-on-this-host`, and that `opencode` does not offer the claustrum-auth
login method.

Typesafe requires a host catalog entry with a usable model. The pinned
OpenCode 2.2.0 catalog lacks it, so `unknown-to-host` is the correct refusal,
not a successful provider smoke. The captured OpenCode 1 catalog also has no
Typesafe models; its plugin may list support, but no turn can be sent. At capture
time the old driver reported `NoBearerModel` even when the catalog model list was
empty. The corrected driver uses `NoCatalogModels` for that case, distinct from
a catalog containing only excluded transports. Do not
invent a model or override the host's catalog to pass.

Steps, per provider:

1. Start OpenCode 2. Run `/claustrum status`: the provider appears with its
   state, and `/claustrum refusals` does not list its credential. A refusal
   there names the fix (`not-on-this-host`, `unsupported-provider`,
   `unmapped`).
2. Run the provider's activation command above. **Pass:** the login succeeds
   and stores nothing but the plugin's placeholder.
3. Start a new session, choose a model of that provider, and send one short
   prompt. **Pass:** a normal answer arrives.
4. Run `/claustrum accounts`. **Pass:** the provider shows one vault account,
   `active, enabled`.
5. Ask for something the provider will reject, if it has a cheap failure path
   (a too-large `max_tokens`, say) and check that the error OpenCode shows
   contains no part of the key. **Pass:** no key material on screen or in
   OpenCode's log.
6. Switch the provider back to your own credential with
   `opencode auth login <provider>` and your key, send another prompt, and
   **pass** when it answers with your key and `/claustrum accounts` no longer
   counts a vault account for it.

## OpenCode 1

The plugin is the same package; OpenCode 1 loads its root entry. Activation is
a slash command, because OpenCode 1 has one auth hook per provider:

| provider | activation |
| --- | --- |
| cerebras | `/claustrum use cerebras` |
| deepseek | `/claustrum use deepseek` |
| fireworks | `/claustrum use fireworks-ai` |
| inception | `/claustrum use inception` |
| cline-pass | `/claustrum use cline-pass` |
| kimi-coding | `/claustrum use kimi-code-plan-global` |
| openrouter | `/claustrum use openrouter` |
| typesafe | `/claustrum use typesafe` |
| meta | `/claustrum use meta` |
| xai | `/claustrum use xai` |
| opencode-go | `/claustrum use opencode-go` |
| opencode-zen | `/claustrum use opencode` |

Steps, per provider:

1. Make sure you have no key of your own for the provider in the shell
   OpenCode runs in: no stored login (`opencode auth logout <provider>`), none
   of the provider's environment variables set, and no
   `provider.<provider>.options.apiKey` in your `opencode.json`. `/claustrum
   use` refuses otherwise and names what to remove.
2. Run the activation command above. **Pass:** it confirms the provider now
   uses vault keys.
3. Restart OpenCode 1 (both commands take effect at the next start), pick a
   model of the provider, send one short prompt. **Pass:** a normal answer.
4. Run `/claustrum accounts`. **Pass:** one vault account, `active, enabled`.
5. Re-run a prompt with one of the provider's environment variables set in the
   shell. **Pass:** the request is refused locally with the "your key is
   shadowed" text and nothing is sent.
6. Run `/claustrum release <provider>`. **Pass:** your own login (or its
   absence) is back, and a prompt with your own key works again.

## Pi

Command per provider (Pi's own ids):

| provider | activation |
| --- | --- |
| cerebras | `/claustrum use cerebras` |
| deepseek | `/claustrum use deepseek` |
| fireworks | `/claustrum use fireworks` |
| kimi-coding | `/claustrum use kimi-coding` |
| openrouter | `/claustrum use openrouter` |
| meta | `/claustrum use meta` |
| xai | `/claustrum use xai` |
| opencode-go | `/claustrum use opencode-go` |
| opencode-zen | `/claustrum use opencode` |

typesafe, inception and cline-pass are not listed on Pi: Pi's catalog has no
inception or cline-pass provider at all, and it registers typesafe with an api
that does not go through the plugin's fetch (`docs/providers.md`).

Steps, per provider:

1. Run `/claustrum` and check the provider's state. `/claustrum refusals`
   should not list its credential. `apikey:fireworks-ai` (fleet id
   `fireworks-ai`) is served here as `fireworks`, and `apikey:kimi-for-coding`
   (fleet id `kimi-code-plan-global`) as `kimi-coding`.
2. Run the activation command above. **Pass:** Pi asks for consent to move the
   existing login aside (when there is one), you accept, and the provider is
   reported as owned.
3. Choose a model of that provider and send one short prompt. **Pass:** a
   normal answer arrives. The owned form offers only the models of the one
   bearer api the plugin registers and hides the rest; the count is in
   `/claustrum`'s provider line. fireworks hides its `anthropic-messages`
   models; opencode-go offers its `openai-completions` models (pick one, for
   example `glm-5.3`); opencode-zen offers its `openai-responses` models (for
   example `gpt-5.4-mini`).
4. Run `/claustrum` again. **Pass:** the provider line says owned with one
   vault account.
5. Run `/claustrum release <provider>`. **Pass:** your own Pi login is back and
   a prompt with it answers.

## Batch 2 checks, on every host that lists the provider

Run these on top of the host's steps above:

- **meta**: **Pass:** the turn answers. A local `insufficient-validity`
  refusal with nothing sent to Meta means the vault served no usable expiry,
  which it should never do (`docs/providers.md`, "Meta: the served token's
  expiry"): record it for the vault's owner as a vault defect. A 401 on a
  later turn is the short-lifetime case: one report, then the next turn
  answers on a freshly minted key.
- **xai**: **Pass:** a turn answers. On OpenCode 2 the turn goes over a
  WebSocket to `wss://api.x.ai` (`docs/providers.md`, "xAI on OpenCode 2"):
  send a second prompt in the same session and **pass** when it answers too
  (the open socket is reused, with a fresh vault read). If the host logs
  "session websocket connect failed; using http", record it: the session
  then runs over HTTP, which is also served.
- **opencode-go**: send one prompt to a bearer model (OpenCode:
  `glm-5.3` or another OpenAI-shaped model; Pi: a model the owned form
  offers) and **pass** when it answers. On OpenCode 1 and 2, then pick an
  Anthropic-shaped model (for example `claude-haiku-5-5`) and **pass** when
  the request is refused locally with "this model's driver sends its key in
  `x-api-key`" before anything is sent.
- **opencode-zen**: OpenCode 1 and Pi only, as opencode-go, with an
  OpenAI-shaped model for the served turn. On OpenCode 2, **pass** when the
  row is listed as `not-on-this-host`.
- **cline-pass** (batch 1, served by credential id): **pass** when
  `/claustrum refusals` does not list `apikey:cline-pass` and a cline-pass
  turn answers, with the vault row still carrying no provider id.

## What "pass" proves, per design 14.4

- the key the provider accepted came from the vault, not from the host's login
  slot: step 1 of each host shows the slot state, step 3 the served turn;
- the request went to the provider's own origin: a misconfigured `baseURL` is
  refused instead (see the models.json case in
  `packages/pi/test/providers.e2e.test.ts` and OpenCode's wrong-origin case);
- nothing leaked back: step 5 of each host looks for the key in errors and
  output.

If a provider fails at step 3 with the provider's own 401, the vault row's key
is not valid for that API; that is a vault data problem, not a plugin one.
