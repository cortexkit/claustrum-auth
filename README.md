# CortexKit Claustrum Auth

CortexKit Claustrum Auth serves provider keys from a [Claustrum](https://github.com/cortexkit/claustrum) vault to OpenCode 1, OpenCode 2 and Pi, for providers that need no special request handling. It is vault-only; use the dedicated [openai-auth](https://github.com/cortexkit/openai-auth), [anthropic-auth](https://github.com/cortexkit/anthropic-auth) and [antigravity-auth](https://github.com/cortexkit/antigravity-auth) plugins for OpenAI/ChatGPT, Anthropic and Google Antigravity instead.

## Install

Quit OpenCode and Pi, then run:

```sh
npx @cortexkit/opencode-claustrum-auth setup
```

Setup detects the hosts and registers the appropriate package: `@cortexkit/opencode-claustrum-auth` for OpenCode or `@cortexkit/pi-claustrum-auth` for Pi. Approve enrollment and grant access in `ck auth`, then follow the printed provider activation commands. See [setup and activation](docs/setup.md) for a dry run, host selection and the separate grant step.

## What it does

- Reads provider keys from the vault. It offers no local sign-in and stores no provider key on disk; the host keeps only a placeholder that holds no secret.
- Uses vault accounts in their set order, and moves to the next account when a provider answers 401 or 429.
- Sends keys only as `Authorization: Bearer` to allowlisted provider origins.
- Provides a `/claustrum` text menu for vault status, account order, provider ownership and refusal reasons.

## Supported providers

The entries below come from the [provider table](packages/core/src/providers.ts). Cells show the host's provider id; `—` means the plugin does not offer that provider on that host. Only models using bearer authentication are served, not every model in a provider's catalog.

| Provider | OpenCode 1 | OpenCode 2 | Pi |
| --- | --- | --- | --- |
| Cerebras | `cerebras` | `cerebras` | `cerebras` |
| Cline Pass | `cline-pass` | `cline-pass` | — |
| DeepSeek | `deepseek` | `deepseek` | `deepseek` |
| Fireworks | `fireworks-ai` | `fireworks-ai` | `fireworks` |
| Inception | `inception` | `inception` | — |
| Kimi Code | `kimi-code-plan-global` | `kimi-code-plan-global` | `kimi-coding` |
| OpenRouter | `openrouter` | `openrouter` | `openrouter` |
| Meta | `meta` | `meta` | `meta` |
| xAI | `xai` | `xai` (WebSocket by default) | `xai` |
| OpenCode Go | `opencode-go` | `opencode-go` | `opencode-go` |
| OpenCode Zen | `opencode` | — | `opencode` |
| Typesafe | Not in host catalog | Not in host catalog | — |

Typesafe has an allowlist entry, but the OpenCode 1 and OpenCode 2 catalogs checked for this release don't list it, so it can't be activated there until a catalog does. OpenCode 2 normally sends xAI over a guarded WebSocket handshake, not its HTTP request path; its HTTP fallback is also guarded. OpenCode Zen is not offered on OpenCode 2. [Provider details](docs/providers.md) records the catalog checks, exact origins, vault metadata and per-model restrictions.

## Documentation

- [Setup and activation](docs/setup.md): enrollment, grants, host selection and activation.
- [Commands](docs/commands.md): the `/claustrum` menu, account ordering and ownership.
- [Providers](docs/providers.md): provider ids, host availability, origins and model restrictions.
- [Security](docs/security.md): bearer-only placement, origin checks, redirects and key scrubbing.
- [Troubleshooting](docs/troubleshooting.md): refusal messages and recovery steps.
- [OpenCode 1](docs/opencode1.md), [OpenCode 2](docs/opencode2.md) and [Pi integration](docs/pi-spike.md): host-specific behaviour.
- [Release](docs/release.md): packaging and publishing.

## License

MIT
