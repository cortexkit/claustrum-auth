# Codebase Structure

A Bun workspace of three TypeScript packages. This file is a map; `ARCHITECTURE.md` explains how the parts work. To find a symbol, search the code rather than this document.

## Workspace

```text
packages/
  core/       @cortexkit/claustrum-auth-core: private, bundled into both npm packages
  opencode/   @cortexkit/opencode-claustrum-auth: OpenCode 1 (root), OpenCode 2 (./server), the claustrum-auth setup command
  pi/         @cortexkit/pi-claustrum-auth: the Pi extension
test/         repository tests: packaging, release, discovery, the live-smoke driver's own tests
scripts/      gate.sh, build and package checks, release.sh, version-sync.mjs, live-smoke/
docs/         user documentation: setup, commands, opencode1, opencode2, providers, security, troubleshooting, live-smoke, release
```

Each package keeps its tests in its own `test/`. `bunfig.toml` preloads `test/preload.ts` and keeps `bun test` out of `target/`, where scratch fixtures can hold looping symlinks.

## `packages/core/src`

- `providers.ts`: the served-provider table, the reserved providers, `classifyRow` and the refusal codes. `docs/providers.md` records the source of every id and origin.
- `placement.ts`: ownership, placement and origin checks; `ClaustrumAuthError` and its refusal codes; response and error scrubbing.
- `fetch.ts`: `createFetch`, one owned request end to end. `serving.ts`: roster-order routes and the serving callbacks.
- `limits.ts`, `balance.ts`: the shared limit policy as adopted here, and the empty-balance 402 rules.
- `runtime.ts`: `createCore`, the hub and its members for one host. The public entry fixes the shipped table; only the test entry supplies fixture services.
- `activation.ts`: the activation and release state machine and the slot queue.
- `menu.ts`, `names.ts`, `startup.ts`, `host.ts`: `/claustrum` text, plugin and enrollment names, safe startup errors, the hosted-mode check.

## `packages/opencode/src`

- `index.ts`: the OpenCode 1 entry. `server.ts`: the OpenCode 2 entry.
- `v1/`: `plugin.ts` (config hook, hub registry, commands), `fetch.ts` (per-provider fetch), `activation.ts` (`/claustrum use` and `release` over OpenCode's auth API), `placeholder.ts`, `effective.ts` (the user's own key, as OpenCode 1 resolves it), `host-auth.ts`, `flags.ts`, `paths.ts`, `messages.ts`.
- `v2/`: `setup.ts` (login methods, gated installer, hooks), `adapter.ts` (the common-auth installer adapter), `vault.ts`, `messages.ts`.
- `setup.ts`, `setup-bin.ts`: the `claustrum-auth setup` command. `state-dir.ts`: the OpenCode state folder.

## `packages/pi/src`

- `extension.ts`: registration, consent, slot changes, serving and `/claustrum`. `models.ts`: which models an owned registration keeps. `flags.ts`: persisted consent and release flags. `messages.ts`: fixed texts. `index.ts`: the published entry.

## Where to add new code

- **A new provider:** an entry in `supportedProviders` with its fleet ids, host ids and origins from the provider's own documentation, and its sources in `docs/providers.md`. Each of its fleet ids needs a row in the vault's provider catalog in group `llm-provider` first, because the plugin's grant is that category and `ck auth put` stamps groups only for catalog ids. Add it only after each host it lists passes the real-host checks for placement, origin and redirect refusal, scrubbing, and a real request (`docs/live-smoke.md`).
- **A provider's empty-balance rule:** `packages/core/src/balance.ts`, only for a 402 the provider documents as an empty balance.
- **A refusal or status text:** the host's `messages.ts` or `ClaustrumAuthError` codes. Fixed text only, never request data or a vault reply.
- **A host behaviour:** `packages/opencode/src/v1/`, `v2/` or `packages/pi/src/`. Logic every host needs goes in `packages/core/src/`.
- **A test:** the package's `test/`. Real-host suites are `packages/opencode/test/opencode1.e2e.test.ts`, `packages/opencode/test/v2/e2e/` and `packages/pi/test/*.e2e.test.ts`.

## Conventions

- Files are kebab-case. Biome formats and lints; `tsc` typechecks; `scripts/check-portability.mjs` runs with lint.
- `bun run build` checks installed ranges, builds the three packages, and checks externals and package contents.
- Nothing is written under OpenCode's config folder; OpenCode state lives in the state folder `state-dir.ts` names.
