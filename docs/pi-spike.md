# Pi spike: what the claustrum-auth Pi extension relies on

The Pi extension is built on three facts about the pinned Pi CLI
(`@earendil-works/pi-coding-agent` 1.3.0 with `@earendil-works/pi-ai`
1.3.0). They are measured by `packages/pi/test/spike.e2e.test.ts`, which runs
the real Pi CLI in RPC mode with a probe extension
(`packages/pi/test/spike-extension.ts`) and a loopback mock provider. Run it
with:

```sh
CLAUSTRUM_AUTH_PI_E2E=1 bun test packages/pi/test/spike.e2e.test.ts
```

CI runs it in the `pi-e2e` job on `ubuntu-latest`, `macos-latest` and
`windows-latest`, so a Pi upgrade that changes any of these facts turns that
job red.

## The facts

1. **Fetch propagation.** A provider registered with a `streamSimple` that
   calls pi-ai's own `streamSimple` with a replaced `fetch` sends every
   request of both `openai-completions` (`/chat/completions`) and
   `openai-responses` (`/responses`) through that `fetch`, with the resolved
   key as `Authorization: Bearer`. The mock saw exactly one request per turn,
   each carrying a header only the caller `fetch` adds: neither api has a
   second transport.
2. **Configured headers reach the caller `fetch`.** A `models.json` model
   `headers` entry (`x-api-key`) arrives in the caller `fetch` beside the
   bearer. This is what makes `fixture-p` reachable: a bearer model whose
   configured headers also carry the placeholder reaches the plugin's fetch,
   which refuses it.
3. **Catalog restoration needs an unregister.** Pi merges a re-registration
   over the previous one and keeps every field the new one leaves out
   (`ModelRuntime.registerProvider`, "merges defined values over the previous
   registration and preserves undefined ones"). So registering a provider
   again **without** `models` keeps the owned form's filtered list; the design's
   assumption (section 9.1) that it restores Pi's catalog is false on 1.3.0.
   `unregisterProvider` followed by `registerProvider` without `models`
   restores the built-in models and the user's `models.json` models exactly
   (measured on `fireworks`: 14 `anthropic-messages` and 8 built-in plus 1
   custom `openai-completions` models before, only the 9 bearer models while
   owned, all 23 again after). The extension therefore unregisters before it
   registers the available form after an owned one.

## Results per OS

| OS | runtime | fact 1 | fact 2 | fact 3 |
| --- | --- | --- | --- | --- |
| macOS (arm64) | Node 24 | holds | holds | holds as stated (merge keeps owned list; unregister restores) |
| Linux (x64) | Node 24.21 | holds | holds | holds as stated |
| Windows (x64) | Bun 1.4.2 (the build machine has no Node; CI runs Node 24) | holds | holds | holds as stated |

## Also found while building on these facts

- Under Node (undici), `new Request(request, { body: null })` takes the body
  of `request` over instead of dropping it, as the Fetch standard says; Bun
  drops it. The shared fetch core built its template that way, so every owned
  request with a body failed on real Pi with "Connection error." It now buffers
  the body first (`packages/core/src/fetch.ts`, with a regression test that
  models the standard's behaviour).
- The extension starts the vault's first account list in the background when
  the session starts, so Pi can be asked for a turn before that list arrives.
  An owned request waits up to two seconds for it before it is refused with
  "no usable account".
