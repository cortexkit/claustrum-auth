# Security boundaries

The plugin serves keys from Claustrum; it does not provide a local login or
API-key store. Enrollment and grants are managed through `ck auth`, separately
for OpenCode and Pi. A grant does not activate a provider: the host must also
choose the plugin as that provider's credential owner.

Vault-only does not mean every request requires a new vault round trip. If a
usable, previously authorized credential receipt is already held in memory,
the shared custody layer can reuse it while the vault is unreachable. The
menu's `Outage receipts` field reports that state; it is not a local sign-in
or a persistent API-key store.

## Providers and origins are allowlisted

The shipped [provider table](../packages/core/src/providers.ts) maps vault
provider ids to host ids and exact API origins. An origin includes the scheme,
host and port, not a path. A provider's HTTPS origin does not admit another
scheme, port, subdomain or custom proxy. The documented Kimi regional origins
are separate entries, not a wildcard.

On OpenCode 2, classification also requires the host catalog to know the
provider and its integration id to equal the provider id. OpenCode 1 uses the
allowlist as its catalog stand-in, so an allowlisted id alone does not prove
that OpenCode has a usable model. Unknown, mixed-service and dedicated-plugin
rows are not a way to add arbitrary endpoints. OpenAI/ChatGPT, Anthropic and
Google are reserved for their dedicated plugins.

## Bearer authentication only

Keys are placed only in `Authorization: Bearer` after the destination and key
placement checks pass. The plugin refuses drivers that put credentials in
`x-api-key`, `x-goog-api-key`, a query string or another unsupported location. This
restriction is about the actual driver, not the model name or whether a
service could accept a bearer instead.

OpenCode Go and Zen contain both bearer and non-bearer models. Only the bearer
routes are served. Pi registers one eligible OpenAI-completions or
OpenAI-responses API per provider and hides models using other APIs while the
provider is vault-owned. See [provider details](providers.md).

## Redirects

- **OpenCode 1 and Pi HTTP:** the plugin sends with manual redirect handling.
  It follows only same-origin redirects, rechecking the destination before
  each send, and limits the redirect chain. It does not follow a cross-origin
  redirect or a redirect URL containing the served key.
- **OpenCode 2 HTTP:** the plugin checks the request's origin before key
  replacement, then uses the host's HTTP transport. In the pinned host,
  cross-origin redirects can reach the other origin, but without the served
  bearer; same-origin redirects retain it. This protection depends on the
  host's redirect behaviour, not the plugin's manual redirect loop.
- **OpenCode 2 xAI WebSocket:** the plugin checks the handshake against the
  separate `wss://api.x.ai` allowlist before reading the vault, and checks that
  the URL has not changed before writing the key. The pinned host follows no
  handshake redirects, including same-origin ones. A failed handshake can
  move the session to HTTP, where the HTTP origin checks apply; a plugin
  refusal fails the turn without that fallback.

The host-specific redirect checks are recorded in
[OpenCode 1](opencode1.md), [OpenCode 2](opencode2.md) and
[provider details](providers.md#xai-on-opencode-2). A custom proxy is not a way
around the origin allowlist.

## Scrubbing served keys

The shared HTTP path scrubs served keys from response bodies, including event
streams, response headers and thrown errors before returning them to the
host. OpenCode 2 also redacts HTTP responses and transport errors. Its xAI
socket path remembers the keys served into each socket and scrubs received
frames before the provider driver reads them.

These are safeguards for provider echoes, not permission to put keys in logs
or issue reports. Keep vault credentials out of manually collected diagnostics.
The plugin does not claim to scrub unrelated secrets that it was never served.
