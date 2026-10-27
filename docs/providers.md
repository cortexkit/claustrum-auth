# Providers the claustrum-auth plugin serves

The plugin serves a provider only when its driver sends the key as
`Authorization: Bearer` and only to the provider's own API origin. The shipped
table is `supportedProviders` in `packages/core/src/providers.ts`; this page
records, per entry, where each id and origin comes from and what the operator's
vault row must look like for the provider to be served.

## The table

| service | OpenCode 1 / 2 id | Pi id | class | allowed origin |
| --- | --- | --- | --- | --- |
| cerebras | `cerebras` | `cerebras` | A | `https://api.cerebras.ai` |
| cline-pass | `cline-pass` | — | A | `https://api.cline.bot` |
| deepseek | `deepseek` | `deepseek` | A | `https://api.deepseek.com` |
| fireworks | `fireworks-ai` | `fireworks` | A | `https://api.fireworks.ai` |
| inception | `inception` | — | A | `https://api.inceptionlabs.ai` |
| kimi-coding | `kimi-for-coding` | `kimi-coding` | A | `https://api.kimi.com` |
| openrouter | `openrouter` | `openrouter` | A | `https://openrouter.ai` |
| typesafe | `typesafe` | — | A | `https://api.typesafe.ai` |

An origin is scheme, host and port; a path is never part of it, so
`https://api.deepseek.com` also admits `/v1/chat/completions`. Every host in
the table writes the key into `Authorization` as a bearer, which is what class
A means (design section 5.2). `—` means the provider is not listed on that
host, and a vault row for it there is refused as `not-on-this-host`.

## Where each fact comes from

Provider base URLs were taken from the packages this repository pins, which
carry the catalogs the hosts themselves use:

- **Pi** `@earendil-works/pi-ai` 1.3.0, `dist/providers/<id>.js` (the provider
  record with its `baseUrl` and `api`) and `dist/providers/data/<id>.json` (its
  models). Pi registers a provider through one api, so a provider whose models
  are not `openai-completions` or `openai-responses` is not listed there.
- **OpenCode 2** `@opencode/ai` 2.0.32, `dist/providers/*.js` (the driver
  defaults and the auth option each route uses).
- **OpenCode 1** uses the same provider ids as OpenCode 2: the table gives it
  the OpenCode ids, and its entry wraps every listed provider's
  `options.fetch` (`packages/opencode/src/v1/plugin.ts`).

| service | Pi catalog | OpenCode 2 driver | bearer |
| --- | --- | --- | --- |
| cerebras | `cerebras`, base `https://api.cerebras.ai/v1`, `openai-completions` | `providers/cerebras.js`, base `https://api.cerebras.ai/v1`, OpenAIChat protocol | yes |
| cline-pass | absent from Pi's catalog | `providers/openai-compatible.js` with the catalog's `api.cline.bot` base | yes (OpenAI-compatible bearer) |
| deepseek | `deepseek`, base `https://api.deepseek.com`, `openai-completions` | `providers/deepseek.js`, base `https://api.deepseek.com/v1` | yes |
| fireworks | `fireworks`, base `https://api.fireworks.ai/inference`, 8 `openai-completions` and 14 `anthropic-messages` models | `providers/fireworks.js`, base `https://api.fireworks.ai/inference/v1` | yes |
| inception | absent from Pi's catalog | `providers/openai-compatible.js` with the catalog's `api.inceptionlabs.ai` base | yes (OpenAI-compatible bearer) |
| kimi-coding | `kimi-coding`, base `https://api.kimi.com/coding/v1`, `openai-completions` | `providers/moonshot.js` (the host routes `kimi-for-coding` through it); the catalog supplies the `api.kimi.com` base | yes |
| openrouter | `openrouter`, base `https://openrouter.ai/api/v1` | `providers/openrouter.js`, base `https://openrouter.ai/api/v1` | yes |
| typesafe | `typesafe`, base `https://api.typesafe.ai/v1/`, api `typesafe-system-one` | `providers/typesafe-ai.js`, base `https://api.typesafe.ai/v1`, `AuthOptions.bearer` | OpenCode yes; Pi's api does not take a caller `fetch` |

Two host rules follow from that table:

- **typesafe is OpenCode only.** Pi registers `typesafe` with its
  `typesafe-system-one` api, which never reaches the caller `fetch`, so the
  plugin's fetch cannot see a typesafe request on Pi (design section 9.2).
- **fireworks and kimi-coding have different ids on the two hosts.** The vault
  matches `provider_ids` exactly, with no fallback, so a row tagged only with
  the OpenCode id is refused on Pi as `host-id-missing`. A row carrying both ids
  of one service is served on both hosts; a 401 still means one key at one
  service, which is why the two ids sit in one entry.

## The operator's vault rows

The plugin routes on row metadata only: the `llm-provider` category, the
credential type, the auth method and `provider_ids` (design section 4.2). It
never reads the credential id to decide where a key goes.

| credential | `provider_ids` | served as |
| --- | --- | --- |
| `apikey:cerebras` | `cerebras` | cerebras on OpenCode 1, OpenCode 2 and Pi |
| `apikey:deepseek` | `deepseek` | deepseek on every host |
| `apikey:fireworks-ai` | `fireworks-ai` | fireworks on OpenCode 1 and 2; refused `host-id-missing` on Pi until the row also names `fireworks` |
| `apikey:inception` | `inception` | inception on OpenCode 1 and 2; refused `not-on-this-host` on Pi |
| `apikey:openrouter` | `openrouter` | openrouter on every host |
| `apikey:typesafe` | `typesafe` | typesafe on OpenCode 1 and 2; refused `not-on-this-host` on Pi |
| `apikey:kimi-for-coding` | `kimi-code-plan-global` | **nothing** (see below) |
| `apikey:cline-pass` | none set | **nothing** (see below) |

Each row must also carry an auth method and be enabled and active in the
vault; a row without one is refused as `no-auth-method`.

## Not served yet

Two of the operator's rows cannot be served as they are, and the plugin says so
through `/claustrum refusals` rather than guessing:

- **`apikey:kimi-for-coding`** names `kimi-code-plan-global`. That id names no
  entry in the supported table, so the row is refused as
  `unsupported-provider` on every host. The fix is a vault-side one: change the
  row's provider ids to `kimi-for-coding` on OpenCode and `kimi-coding` on Pi,
  or set both, and the existing entry serves it with no plugin change. The
  design's rule against parsing credential ids (the name `kimi-for-coding`
  looks like a provider id) is why the plugin does not infer this itself.
- **`apikey:cline-pass`** carries no provider id at all. Design section 4.2
  step 3 requires an id: a row without one is refused as `unmapped`, on purpose
  (`oauth:cursor` and `apikey:muse` are today). There is no rule that maps an
  id-less row to a provider by its credential id or its adapter, so this key
  cannot be served until the vault sets its provider ids to `cline-pass`. The
  table already lists `cline-pass` on OpenCode, so only the metadata is
  missing.

Neither fix needs a release of the plugin.

## Before this table is live: the design's section 14.4 list

The table above is the shipped allowlist, and the design's "listing a provider
as supported" rules (section 14.4) still apply per host:

1. the host's catalog knows the id, and on OpenCode 2 the integration id equals
   the provider id — checked at classification, per request;
2. the per-driver transport audit for that host version — the plugin serves
   only through OpenCode 2's `http.request` hook, OpenCode 1's `options.fetch`
   and Pi's caller `fetch`. These drivers reach the key through the SDK's
   bearer option, which that seam sees; a per-host audit of the pinned host
   versions is still owed before each entry is called proven;
3. the driver and header match the table above;
4. the origin is recorded and the wrong-origin case passes, on each host;
5. the echoed-credential redaction case passes;
6. one operator-run live smoke completes a turn with a real vault key —
   `docs/live-smoke.md` has the steps per provider and host.

Steps 4 and 5 run in the mock-provider suites; step 6 is the manual smoke.
