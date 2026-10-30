# Providers the claustrum-auth plugin serves

The plugin serves a provider only when its driver sends the key as
`Authorization: Bearer` and only to the provider's own API origin. The shipped
table is `supportedProviders` in `packages/core/src/providers.ts`; this page
records, per entry, where each id and origin comes from and what the operator's
vault row must look like for the provider to be served.

## The table

| service | fleet id (`provider_ids`) | OpenCode 1 id | OpenCode 2 id | Pi id | allowed origin |
| --- | --- | --- | --- | --- | --- |
| cerebras | `cerebras` | `cerebras` | `cerebras` | `cerebras` | `https://api.cerebras.ai` |
| cline-pass | none: credential `apikey:cline-pass` | `cline-pass` | `cline-pass` | — | `https://api.cline.bot` |
| deepseek | `deepseek` | `deepseek` | `deepseek` | `deepseek` | `https://api.deepseek.com` |
| fireworks | `fireworks-ai` | `fireworks-ai` | `fireworks-ai` | `fireworks` | `https://api.fireworks.ai` |
| inception | `inception` | `inception` | `inception` | — | `https://api.inceptionlabs.ai` |
| kimi-coding | `kimi-code-plan-global` | `kimi-code-plan-global` | `kimi-code-plan-global` | `kimi-coding` | `https://api.kimi.com`, `https://api.kimi.ai` |
| openrouter | `openrouter` | `openrouter` | `openrouter` | `openrouter` | `https://openrouter.ai` |
| typesafe | `typesafe` | `typesafe` | `typesafe` | — | `https://api.typesafe.ai` |
| meta | `meta` | `meta` | `meta` | `meta` | `https://api.meta.ai` |
| xai | `xai` | `xai` | `xai` | `xai` | `https://api.x.ai`; WebSocket handshake on OpenCode 2: `wss://api.x.ai` |
| opencode-go | `opencode-go` | `opencode-go` | `opencode-go` | `opencode-go` | `https://opencode.ai` |
| opencode-zen | `opencode` | `opencode` | — | `opencode` | `https://opencode.ai` |

All entries are class A (design section 5.2): the key travels only in
`Authorization` as a bearer. An origin is scheme, host and port; a path is
never part of it, so `https://api.deepseek.com` also admits
`/v1/chat/completions`. `—` means the provider is not listed on that host, and
a vault row for it there is refused as `not-on-this-host`.

The table records allowlist mappings, not a promise that the running host's
catalog offers a usable model. Typesafe is absent from the checked OpenCode
catalogs and is therefore unavailable there; OpenCode 2 reports
`unknown-to-host`. It is not offered on Pi either. OpenCode 2 uses a guarded
WebSocket handshake for xAI
by default, with a guarded HTTP fallback, rather than the ordinary HTTP path
used by OpenCode 1 and Pi. OpenCode Zen is not offered on OpenCode 2. See the
host rules below and the [landing-page availability table](../README.md#supported-providers).

### Fleet ids, not host ids

A vault row's `provider_ids` use the fleet's vocabulary: the ids fleet routing
and pricing use. The vault owner does not retag rows to suit this plugin, so
the table maps each fleet id to the running host's own id:

- `fireworks-ai` is `fireworks-ai` on OpenCode and `fireworks` on Pi;
- `kimi-code-plan-global` is also `kimi-code-plan-global` on OpenCode and `kimi-coding`
  on Pi;
- every other entry's fleet id is the same as its host ids.

A row is served only when every id it carries is a fleet id of one entry. A
fleet id the table has no mapping for is refused as `unsupported-provider` and
listed by `/claustrum refusals`; the plugin never guesses. A host id that is
not also a fleet id (`fireworks`, `kimi-coding`) is no
exception. A row with ids of two entries, or a known id beside an unknown one,
is refused as `mixed-services`, because a 401 on it would not name one service
(design section 4.3).

### cline-pass: served by its exact credential id

`apikey:cline-pass` carries no provider id on purpose. With one, fleet routing
picked the key and sent fleet workers to it, so the row stays unmapped and
fleet routing never picks it. The plugin serves it through its cline-pass
entry, which names the exact credential id `apikey:cline-pass`. The match is
exact (no prefix, no pattern, no case folding) and is used only when the row
has no provider ids at all: `apikey:cline-pass-2` with no provider id is still
refused as `unmapped`, and a row that does carry provider ids is classified
by those ids alone. This is the only place the plugin looks at a credential
id; everything else routes on row metadata (design section 4.2).

## Where each fact comes from

Provider ids, base URLs and apis were taken from the packages this repository
pins, which carry the catalogs the hosts themselves use:

- **Pi** `@earendil-works/pi-ai` 1.3.0, `dist/providers/<id>.js` (the provider
  record with its `baseUrl` and `api`) and `dist/providers/data/<id>.json` (its
  models, grouped by api, each with its `baseUrl`). Pi registers a provider
  through one api, so a provider whose models are not `openai-completions` or
  `openai-responses` is not listed there.
- **OpenCode 2** `@opencode/ai` 2.2.0, `dist/providers/*.js` (the driver
  defaults and the auth option each route uses).
- **OpenCode 1** uses the same provider ids as OpenCode 2: the table gives it
  the OpenCode ids, and its entry wraps every listed provider's
  `options.fetch` (`packages/opencode/src/v1/plugin.ts`). Its transport audit
  for v1.19.3 is design section 8.4.
- **models.dev** (`https://models.dev/api.json`), the catalog both OpenCode
  hosts load, for the per-model drivers of opencode-go and opencode-zen.

| service | Pi catalog | OpenCode 2 driver | bearer |
| --- | --- | --- | --- |
| cerebras | `cerebras`, base `https://api.cerebras.ai/v1`, `openai-completions` | `providers/cerebras.js`, base `https://api.cerebras.ai/v1`, OpenAIChat protocol | yes |
| cline-pass | absent from Pi's catalog | `providers/openai-compatible.js` with the catalog's `api.cline.bot` base | yes (OpenAI-compatible bearer) |
| deepseek | `deepseek`, base `https://api.deepseek.com`, `openai-completions` | `providers/deepseek.js`, base `https://api.deepseek.com/v1` | yes |
| fireworks | `fireworks`, base `https://api.fireworks.ai/inference`, 8 `openai-completions` and 14 `anthropic-messages` models | `providers/fireworks.js`, base `https://api.fireworks.ai/inference/v1` | yes |
| inception | absent from Pi's catalog | `providers/openai-compatible.js` with the catalog's `api.inceptionlabs.ai` base | yes (OpenAI-compatible bearer) |
| kimi-coding | `kimi-coding`, base `https://api.kimi.com/coding/v1`, `openai-completions` | `providers/moonshot/chat.js` (the host routes `kimi-code-plan-global` through it); the catalog supplies the regional base | yes |
| openrouter | `openrouter`, base `https://openrouter.ai/api/v1` | `providers/openrouter.js`, base `https://openrouter.ai/api/v1` | yes |
| typesafe | `typesafe`, base `https://api.typesafe.ai/v1/`, api `typesafe-system-one` | `providers/typesafe-ai.js`, base `https://api.typesafe.ai/v1`, `AuthOptions.bearer` | OpenCode yes; Pi's api does not take a caller `fetch` |
| meta | `meta` (`providers/meta.js`), base `https://api.meta.ai/v1`, `openai-responses`, 6 models | `providers/meta.js`, base `https://api.meta.ai/v1`; responses, chat and messages routes all use `AuthOptions.bearer(input, "META_API_KEY")` | yes |
| xai | `xai` (`providers/xai.js`), base `https://api.x.ai/v1`, `openai-responses`, 4 models | `providers/xai.js`, base `https://api.x.ai/v1`, `AuthOptions.bearer(options, "XAI_API_KEY")`; WebSocket transport by default on OpenCode 2 (below) | yes, over HTTP and in the WebSocket handshake |
| opencode-go | `opencode-go` (`providers/opencode-go.js`), four apis, models at `https://opencode.ai/inference/go` (see below) | per model (see below) | per model |
| opencode-zen | `opencode` (`providers/opencode.js`), five apis, models at `https://opencode.ai/inference` (see below) | `providers/opencode.js` (TypeSafe System One at `https://opencode.ai/inference/systemone/v1`, bearer) plus per-model drivers | per model |

Host rules that follow:

- **Kimi Code's provider id is `kimi-code-plan-global`, not its model id.**
  The OpenCode 1 models.dev catalog (`https://models.dev/api.json`, read
  2026-10-29; live capture `opencode1/api-110.json:1`) lists six models under
  that provider, with base `https://api.kimi.ai/coding/v1`. The bundled catalog
  in the pinned `@opencode/cli` 2.2.0 returns the same provider and integration
  id through the plugin's `ctx.provider.get` with model fetching disabled
  (checked 2026-10-29). Its snapshot source is
  [`packages/core/src/models-dev/snapshot.txt` at v2.2.0](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/core/src/models-dev/snapshot.txt).
  `kimi-for-coding` is not a provider alias. Kimi's first-party
  [Kimi Code docs](https://www.kimi.com/code/docs/en), **Service Endpoint**
  (read 2026-10-29), document the OpenAI-compatible endpoints as China
  `https://api.kimi.com/coding/v1` and Overseas
  `https://api.kimi.ai/coding/v1`. Only those two exact HTTPS origins are
  allowed; another scheme, port or Kimi subdomain is not.

- **typesafe is OpenCode only.** Pi registers `typesafe` with its
  `typesafe-system-one` api, which never reaches the caller `fetch`, so the
  plugin's fetch cannot see a typesafe request on Pi (design section 9.2).
  OpenCode support is conditional on the host catalog containing a `typesafe`
  provider and a usable model; the driver package's existence alone is not
  enough. The 2026-10-29 OpenCode 1 capture (`opencode1/api-110.json:1`) has
  no Typesafe provider or models: it is listed by the plugin's support table
  but unservable on that host, not a passed turn. OpenCode 2.2.0's bundled
  catalog also lacks it (`ctx.provider.get`, model fetching disabled, checked
  2026-10-29), so `unknown-to-host` correctly refuses it before activation.
- **xai is served over WebSocket on OpenCode 2.** See "xAI on OpenCode 2"
  below. OpenCode 1 sends xAI over HTTP through `options.fetch` (design
  section 8.4) and Pi through the caller `fetch` of `openai-responses`.
- **opencode-zen is not on OpenCode 2.** OpenCode 2's built-in Console plugin
  reads the stored `opencode` credential and calls the Console with it outside
  the request hooks (design section 5.2, class D). OpenCode 1's `opencode`
  loader only checks that a key is stored (design section 8.4).

## xAI on OpenCode 2

OpenCode 2.2.0 sends xAI turns over a WebSocket. Citations prefixed `oc:` are
the host's source at tag `v2.2.0` (`github.com/anomalyco/opencode`); the
same code is in the minified bundle of the pinned `@opencode/cli` 2.2.0
binary, which is what the real-host tests run.

**Which requests use the socket.** The built-in xAI plugin sets
`settings.transport` to `websocket` for provider id `xai` unless the
configuration sets it (`oc:packages/core/src/plugin/provider/xai.ts:98-105`).
The session opens a socket only for a model whose transport is `websocket`
(`oc:packages/core/src/session/model-request.ts:354-378`); everything else of
the provider, and every session that fell back (below), goes over HTTP
through `http.request`, served as for every other provider. The xAI
Responses route builds the socket URL from the base URL plus `/responses`,
`https:` becoming `wss:` (`@opencode/ai` 2.2.0
`dist/providers/xai.js:12-20`, `dist/route/transport/websocket.js:104-129`),
so the default target is `wss://api.x.ai/v1/responses`. A user sets
`providers.xai.settings.transport` to `http` to turn the socket off.

**Where the key goes, and when.** Route auth writes `authorization: Bearer
<stored credential>` while the transport is prepared, after `model.request`
has run, so a header set in `model.request` loses to it
(`oc:packages/core/src/session/model-request.ts:303-319`,
`oc:packages/ai/src/route/auth.ts:46-71`). The handshake hook then receives
the prepared URL and headers, with the plugin's placeholder in
`authorization`, and whatever it returns is what the socket is opened with
(`oc:packages/core/src/session/model-transport.ts:309-345`). The plugin
therefore writes the vault key there:

1. its own `experimental.ws.handshake` hook, registered before common-auth's
   installer, checks a handshake carrying the placeholder against the
   entry's `handshakeOrigins` (`wss://api.x.ai`, scheme, host and port) and
   refuses any other origin with a fixed message, before an account is
   chosen or the vault read;
2. the installer refuses a placeholder outside `Authorization`, chooses the
   account, and asks `accountHeaders`, which reads the vault only for the
   handshake whose origin step 1 passed;
3. `rewriteHandshakeURL` refuses the handshake if its URL is no longer the one
   step 1 checked (another plugin's hook in between moved it), before the key
   is written; then `Authorization: Bearer <vault key>` replaces the
   placeholder, and the installer's wire guard checks that no placeholder is
   left.

An `http.request` of the same session clears what step 1 left, so an HTTP
request never reads the vault before its own origin check.

**One read per send; the socket follows the key.** The host runs the handshake
hook for every model call, also when the session's socket is already open,
and reuses the socket only while the URL and every header value are
unchanged (`oc:packages/core/src/session/model-transport.ts:116-138,309-345`).
So the vault is read for every turn, the same key keeps the socket, and a
changed key (another account, a rotated key, the user's own key after a
login switch) opens a new one. A login switch or a revoked vault mode reaches
an open socket at the next send: the hook refuses or passes it through
before the host picks the socket. xAI's sockets are also rotated after 24
minutes (`dist/providers/xai.js:13`).

**Failures.** A handshake that does not open (any non-101 answer, a redirect,
a refused connection) moves that session to HTTP for good: the host keeps a
per-session flag and later turns skip the socket
(`oc:packages/core/src/session/model-transport.ts:308-310,343-363`). The
HTTP request is served normally. No hook sees a handshake's status, so a
handshake 401 is not reported; the HTTP request that follows it is, once. A
handshake hook that throws (the plugin's refusals) fails the turn without the
HTTP fallback, and the host shows its own "Failed to read
xai/xai-responses stream" while logging the plugin's fixed refusal as the
cause.

**Redirects.** The host opens sockets with Bun's `WebSocket` (with `ws` and
`followRedirects: false` outside Bun,
`oc:packages/core/src/effect/websocket-constructor.ts:58-79`); the real-host
test shows the pinned binary follows no handshake redirect at all, cross- or
same-origin, and the second origin never sees the key.

**Frames.** Received frames pass the plugin's `experimental.ws.receive` hook,
which removes every key served into that socket from error frames before the
host's driver reads them. Error frames carry the provider's status: a 429 is
a limit on the account (the retry moves the turn to the next account, on a
new socket), a 401 is reported once for the receipt that socket was served.

**Voice.** Grok Voice does not use these hooks. The host's voice service
looks for an `env` or `key` connection of the `xai` integration and needs a
resolved API key (`/realtime/client_secrets` over plain HTTP); it never reads
the plugin's OAuth-typed placeholder, so with the vault owning xAI it asks
for an API key and the vault key never reaches it (the `Voice.session` code
in the pinned binary, the host's `Realtime.connect` for `xai-realtime`).

## OpenCode Go and OpenCode Zen: bearer models only

Both services choose a driver per model, and only models whose driver sends
the key as `Authorization: Bearer` are served. A model whose driver puts the
key in `x-api-key` (Anthropic-shaped) or `x-goog-api-key` (Google-shaped) is
refused per request, before the vault is read (design section 5.3): on
OpenCode the placeholder is found in that header and the request fails with
"this model's driver sends its key in `<header>`"; on Pi the owned
registration does not offer the model at all.

### On Pi

Counts from `dist/providers/data/<id>.json` of pi-ai 1.3.0. Pi serves one api
per registration, the bearer api most of the provider's models use
(`packages/pi/src/models.ts`), and hides every other model while the provider
is vault-owned (design section 9.2).

**opencode-go**, 29 models:

| api | base URL | count | served while owned | models |
| --- | --- | --- | --- | --- |
| `openai-completions` | `https://opencode.ai/inference/go/v1` | 18 | yes | cat-jam-free, deepseek-v4-pro, deepseek-v4.1-flash, glm-5.2, glm-5.3, glm-5.3-flash, hy3, hy4-preview, kimi-k2.7-code, kimi-k3, longcat-2.0, longcat-2.5-preview-free, mimo-v2.5, mimo-v2.5-pro, mimo-v2.6-flash, mimo-v2.6-pro, space-bunny, step-5-preview-free |
| `openai-responses` | `https://opencode.ai/inference/go/v1` | 5 | no: bearer, but not the registered api | gpt-5.6-luna, gpt-6-luna, grok-4.7, muse-spark-1.2-contributor, muse-spark-1.3-contributor |
| `anthropic-messages` | `https://opencode.ai/inference/go` | 5 | no: key in `x-api-key` | claude-haiku-5-5, minimax-m3, qwen3.7-plus, qwen3.8-flash, qwen3.8-max |
| `google-generative-ai` | `https://opencode.ai/inference/go/v1` | 1 | no: key in `x-goog-api-key` | gemini-4-argon-contributor |

**opencode** (Zen), 84 chat models and 2 classifiers:

| api | base URL | count | served while owned |
| --- | --- | --- | --- |
| `openai-responses` | `https://opencode.ai/inference/v1` | 30 | yes |
| `openai-completions` | `https://opencode.ai/inference/v1` | 28 | no: bearer, but not the registered api |
| `anthropic-messages` | `https://opencode.ai/inference` | 18 | no: key in `x-api-key` |
| `google-generative-ai` | `https://opencode.ai/inference/v1` | 8 | no: key in `x-goog-api-key` |
| `typesafe-system-one` (classifiers) | `https://opencode.ai/inference/v1` | 2 | no: api does not take a caller `fetch` |

Both providers wrap each api with pi-ai's `withOpenCodeSessionHeader`, which
adds an `x-opencode-session` routing header (a session id, not a credential);
the plugin's stream hands owned calls to pi-ai's own `streamSimple`, which
dispatches to that wrapped provider, so the header is kept.

### On OpenCode 1 and OpenCode 2

Both OpenCode hosts take the per-model driver from models.dev: a model's
`provider.npm` when it has one, else the provider's `npm`. Read from
`https://models.dev/api.json` on 2026-10-27 (`$["opencode-go"].models[*].provider`
and `$["opencode"].models[*].provider`). OpenCode 2 starts from the snapshot
bundled with 2.2.0 and OpenCode 1 loads the live catalog, so the model lists
can drift; the header rule per driver does not. The header each driver sends
is from `@opencode/ai` 2.2.0 `dist/providers/`: `openai.js:31`,
`openai-compatible.js:11` and `mistral.js:12` use `AuthOptions.bearer`;
`anthropic.js:12` sends `x-api-key` and `google.js:17` sends
`x-goog-api-key`. OpenCode 1's AI SDK packages of the same names send the same
headers.

OpenCode's own documentation accepts `Authorization: Bearer` on every
inference route, Anthropic- and Google-shaped included
(`https://opencode.ai/docs/go/#endpoints`, `https://opencode.ai/docs/zen/#endpoints`,
`https://opencode.ai/v2/docs/console/api/inference/#authentication`). What
decides is the header the host's driver writes, so the Anthropic and Google
models are still refused: the vault key is never put in a header that a
cross-origin redirect would carry along (design section 5.2, class C).

**opencode-go** on OpenCode 1 and 2, 37 models:

| driver | base URL | count | served | models |
| --- | --- | --- | --- | --- |
| `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/go/openai/v1` | 24 | yes | beam-free, cat-jam-free, deepseek-v4-pro, deepseek-v4.1-flash, glm-5.2, glm-5.3, glm-5.3-flash, hy3, hy4-preview, iceman-contributor-free, kimi-k2.7-code, kimi-k3, kimi-k3.1-pro, longcat-2.0, longcat-2.5-preview-free, mimo-v2.5, mimo-v2.5-pro, mimo-v2.6-flash, mimo-v2.6-pro, minimax-m3.1-flash, minimax-m3.1-flash-free, space-bunny, step-5-preview, step-5-preview-free |
| `@ai-sdk/openai` | `https://opencode.ai/inference/go/openai/v1` | 5 | yes | gpt-5.6-luna, gpt-6-luna, grok-4.7, muse-spark-1.2-contributor, muse-spark-1.3-contributor |
| `@ai-sdk/anthropic` | `https://opencode.ai/inference/go/anthropic/v1` | 6 | no: `x-api-key` | claude-haiku-5-5, minimax-m2.7, minimax-m3, qwen3.7-plus, qwen3.8-flash, qwen3.8-max |
| `@ai-sdk/google` | `https://opencode.ai/inference/go/google/v1beta` | 2 | no: `x-goog-api-key` | gemini-4-argon, gemini-4-argon-contributor |

**opencode** (Zen) on OpenCode 1 only, 130 models:

| driver | base URL | count | served |
| --- | --- | --- | --- |
| `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/openai/v1` | 63 | yes |
| `@ai-sdk/openai` | `https://opencode.ai/inference/openai/v1` | 33 | yes |
| `@ai-sdk/mistral` | `https://opencode.ai/inference/openai/v1` | 1 (mistral-large-4) | yes |
| `@ai-sdk/anthropic` | `https://opencode.ai/inference/anthropic/v1` | 24 | no: `x-api-key` |
| `@ai-sdk/google` | `https://opencode.ai/inference/google/v1beta` | 9 | no: `x-goog-api-key` |

The Zen Anthropic models are the `claude-*` models plus minimax-m2.1-free,
minimax-m2.5-free, minimax-m3-free, qwen3.5-plus, qwen3.6-plus,
qwen3.6-plus-free and qwen3.8-flash; the Google models are the `gemini-*`
models. The same model name can take a different driver on the two services
(minimax-m3 is Anthropic-shaped on Go and OpenAI-compatible on Zen), so the
plugin decides per request from the header, never from the model name.

Every base URL of both services is on `https://opencode.ai`, the one allowed
origin; `opencode.js` on OpenCode 2 also targets
`https://opencode.ai/inference/systemone/v1` for TypeSafe's System One.

## Meta: the served token's expiry

`oauth:meta` is an OAuth row. The vault serves a minted Meta inference key for
it, and the plugin sends it as the bearer like any other key. Custody, in
`@cortexkit/common-auth` 0.27.0, treats an OAuth read differently from an API
key read (`dist/claustrum/custody.js:542-554`):

- it asks the vault for at least five minutes of validity (`min_ttl_ms`
  300000, `SERVING_MARGIN_MS`);
- it refuses the served credential as `insufficient-validity` when
  `expires_at_ms` is null, or when less than five minutes remain.

The vault serves the minted Meta key with a real `expires_at_ms`, never null
(answered by the vault's owner, 2026-10-27). It holds Meta's identity token
and serves only the key it mints from it. The expiry is the first of these
that exists:

1. the expiry in Meta's mint reply (`expires_at_ms`, `expires_at` as seconds
   or RFC 3339, or `expires_in`);
2. otherwise the key's own JWT `exp`, if the key is a JWT;
3. otherwise mint time plus 24 hours, an assumption the vault states and tests.

A malformed expiry fails the vault's refresh; it is never replaced by the
fallback. Because the row is refreshable, asking with `min_ttl_ms` 300000
makes the vault mint a fresh key once the current one has less than five
minutes left, so custody's check holds as it stands.

If Meta's real key lifetime is shorter than the 24-hour assumption, a key can
stop working early. The plugin then gets a 401, reports it once for the record
version it was served, and the vault mints a new key.

xAI is an OAuth row too, so the same rule applies to `oauth:xai`.

## The operator's vault rows

The plugin routes on row metadata only: the `llm-provider` category,
`authMethod` and `providerIds` (the wire's `provider_ids`),
plus the one exact credential id above. `authMethod` alone determines the
authentication type: `apikey`, `chatgpt`, `antigravity`, or `oauth`. The last
three describe logins; ChatGPT and Antigravity belong to dedicated plugins.
`credentialType` is only a hint parsed from the credential id, never a type
decision. In particular, real API-key rows have `credentialType: "apikey"`
and `authMethod: "apikey"`, with no `refreshAdapter`.

`refreshAdapter` identifies a login's refresher when it has one, not its
authentication type. It is consulted only for dedicated-plugin ownership,
not to discover API keys, select a provider, or infer quota. `serves` names
model families, not credential providers: Cerebras serving `openai` models
does not make its key an OpenAI credential. Plan-tier metadata does not
select the provider either.

| credential | `provider_ids` | category | served as |
| --- | --- | --- | --- |
| `apikey:cerebras` | `cerebras` | `llm-provider` | cerebras on OpenCode 1, OpenCode 2 and Pi |
| `apikey:deepseek` | `deepseek` | `llm-provider` | deepseek on every host |
| `apikey:fireworks-ai` | `fireworks-ai` | `llm-provider` | `fireworks-ai` on OpenCode 1 and 2, `fireworks` on Pi |
| `apikey:inception` | `inception` | `llm-provider` | inception on OpenCode 1 and 2; refused `not-on-this-host` on Pi |
| `apikey:openrouter` | `openrouter` | `llm-provider` | openrouter on every host |
| `apikey:typesafe` | `typesafe` | `llm-provider` | allowlisted on OpenCode 1 and 2, but unavailable in the checked catalogs; OpenCode 2 refuses `unknown-to-host`, Pi `not-on-this-host` |
| `apikey:kimi-for-coding` | `kimi-code-plan-global` | `llm-provider` | `kimi-code-plan-global` on OpenCode 1 and 2, `kimi-coding` on Pi |
| `apikey:cline-pass` | none | `llm-provider` | cline-pass on OpenCode 1 and 2, by its exact credential id; refused `not-on-this-host` on Pi |
| `oauth:meta` | `meta` | `llm-provider,meta-native` | meta on every host, once the vault serves its expiry (above) |
| `oauth:xai` | `xai` | `llm-provider,xai-native` | xai on every host; on OpenCode 2 over WebSocket by default, with guarded HTTP fallback |
| `apikey:opencode-go` | `opencode-go` | `llm-provider` | opencode-go on every host, bearer models only |
| `apikey:opencode-zen` | `opencode` | `llm-provider` | opencode on OpenCode 1 and Pi, bearer models only; refused `not-on-this-host` on OpenCode 2 |

Each row must also carry an auth method and be enabled and active in the
vault; a read row without `authMethod` is unknown and refused as
`unknown-auth-method` by common-auth, even if its id or `credentialType`
looks familiar. The plugin
never guesses a missing auth method from the id or refresher.

**The `*-native` categories.** `meta-native` and `xai-native` mark rows a
dedicated plugin may own later. The design does not reserve them: the plugin
reads one grant on `category:llm-provider` and classifies by auth method and
provider id (design sections 4.1-4.2), and its reserved set is the provider
ids the installed dedicated plugins register (`openai`, `openai-codex`,
`anthropic`, `anthropic-platform`, `google`, design section 10). No dedicated
Meta or xAI plugin exists, so these rows are served. When one is added, its
provider id joins the reserved set (design section 10: "reviewed when a
dedicated plugin is added"), and the rows then show as `reserved-provider`.

## Support checks

The table above is the shipped allowlist, and the design's "listing a provider
as supported" rules (section 14.4) still apply per host:

1. the host's catalog knows the id, and on OpenCode 2 the integration id equals
   the provider id — checked at classification, per request;
2. the per-driver transport audit for that host version — the plugin serves
   only through OpenCode 2's `http.request` hook (and, for xAI alone, its
   `experimental.ws.handshake` hook, audited in "xAI on OpenCode 2"),
   OpenCode 1's `options.fetch` and Pi's caller `fetch`. These drivers reach
   the key through the SDK's bearer option, which that seam sees; a per-host
   audit must cover the pinned host version before an entry is called proven;
3. the driver and header match the table above;
4. the origin is recorded and the wrong-origin case passes, on each host;
5. the echoed-credential redaction case passes;
6. one operator-run live smoke completes a turn with a real vault key —
   `docs/live-smoke.md` has the steps per provider and host.

Steps 4 and 5 run in the mock-provider suites; step 6 is the manual smoke.
