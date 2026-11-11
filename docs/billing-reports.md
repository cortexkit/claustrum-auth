# Vault-served request billing

OpenCode 2 HTTP, its xAI Responses WebSocket frames, and Pi send optional
`kind: billing` reports through `@cortexkit/common-auth/routing-accessor`.
OpenCode 1 does not report. The plugin creates an accounting record only after
a request carrying the plugin's placeholder key (not the user's own key)
receives a vault receipt identifying the credential authorized for that send,
and the process-global
`Symbol.for('cortexkit.routing')` accessor is callable. Without it, billing does
not wrap responses, acquire readers, or look up usage semantics. Existing
credential-redaction and host lifecycle wrappers still apply.

Each reported model-call attempt has its own random UUID, including retries and
account reroutes. Same-origin redirect hops that core follows are not model
calls and produce no report; only the terminal send that core returns to the
host, or a send that ends in an error, reports. HTTP reports settle when the body ends,
errors or is cancelled, not when headers arrive. Successful Pi sends wait for
pi-ai's final assistant message to supply the stored `responseId` and outcome;
their usage comes from the provider reply through the same table as OpenCode 2,
not pi-ai's normalized counters (which supply zeroes for missing fields).
Unsuccessful sends settle before replacement sends. xAI WebSocket reports settle
at the terminal Responses frame, or on the host's attempt-end callback for an
abandoned/failed attempt. The socket can remain open between sends.

Reports carry the receipt's exact credential id and, if present, account identity.
`provider` is the **host catalog id**, not the provider id in the vault's fleet
roster: Kimi is
`kimi-code-plan-global` on OpenCode 2 and `kimi-coding` on Pi. **Pricing gap:**
Pi's `kimi-coding` id does not match the pricing catalog's
`kimi-code-plan-global`; that catalog mapping must be resolved on the pricing
side, without changing the host id in the report. The model comes
from the hook's `modelID` or Pi's `model.id`; no request body is parsed to find it.
Reply model names are ignored: providers often echo aliases, prefixes or dated
versions of the sent model. The plugin never sends `usageByModel`, because those
names are not a reliable reroute signal and may lack pricing catalog coverage. OpenCode's `kind` maps directly to `primary`, `title`, `compaction`, or
`generate`; Pi uses `primary`. Host-provided retry attempt numbers are retained
when available; Pi numbers reported model-call attempts within its stream.

Outcomes follow the openai-auth convention: a provider error or non-2xx status
is `failed`; a completed reply whose body ended is `completed`; otherwise a
response with output is `cut` and one without output is `failed`.
When a host cancels after a provider terminal signal (Chat `finish_reason` or
`[DONE]`, Responses completed/incomplete, or parsed JSON), the answer is already
complete, so it reports `completed` even without byte EOF. Cancellation before
terminal and transport read errors remain cut/failed. If usage would have
arrived in a later chunk, it stays absent rather than being invented. Optional
accounting never awaits report delivery. Non-streaming JSON observation retains
at most 1 MiB; larger replies still report, without parsed usage.

## Usage semantics and sources

The `billing` rows in `packages/core/src/providers.ts` are the extraction and
semantics table for both hosts. Field paths below are relative to `usage` unless
specified otherwise. Missing counts stay absent; zero is retained only when
reported. Each stream retains the latest raw value of every reported counter;
cache subtraction, flooring at zero and write-lifetime summation happen once
when the report is built, so counts may arrive in different chunks. OpenCode's
cache-exclusive token namespace remains separate from generic prompt totals.
When prompt counts include cache but the reply supplies no cache
counter, `input` is the reported prompt count and **may include cache hits**.
The plugin never changes `stream_options`, `perf_metrics_in_response`, or any
other request field to obtain accounting.

**Standard OpenAI assumption:** where provider documentation names standard
OpenAI fields but does not define their inclusion semantics, use OpenAI's
[Chat Completions usage](https://platform.openai.com/docs/api-reference/chat/object#chat/object-usage)
and [Responses usage](https://platform.openai.com/docs/api-reference/responses/object#responses/object-usage):
`prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` are
subsets of prompt/input; `completion_tokens_details.reasoning_tokens` /
`output_tokens_details.reasoning_tokens` are included in output. Such rows are
marked **assumed (OpenAI field semantics)** below. Nonstandard undocumented
counts are not guessed. The generic OpenAI fallback reads either the Chat
`prompt_tokens` / `completion_tokens` pair or Responses `input_tokens` /
`output_tokens`, their standard cached/reasoning details, and no cache-write
field unless explicitly listed.

| Provider | Usage fields / inclusion rules | Stream availability; automatic cache | Charge basis and official sources |
| --- | --- | --- | --- |
| DeepSeek | `prompt_tokens` includes `prompt_cache_hit_tokens` (preferred to standard cached detail); `completion_tokens` includes standard reasoning detail. Cache-read and reasoning inclusion **verified live** for `deepseek-flash` on 2026-11-11; see evidence below. No documented write count. | Usage on the final finish/content chunk even without opt-in. **Implicit cache**. | `metered_api`. [API](https://api-docs.deepseek.com/api/create-chat-completion), [context caching](https://api-docs.deepseek.com/guides/kv_cache), [pricing](https://api-docs.deepseek.com/quick_start/pricing). |
| Cerebras | `prompt_tokens` includes `prompt_tokens_details.cached_tokens`; `completion_tokens` includes standard reasoning detail, **verified live** for `qwen-3.8-27b` on 2026-11-11. Cache inclusion was untested in that run (no hit). No documented write count. | Documented stream includes usage without opt-in. **Implicit cache**. | Omitted: the same key can span trial, PayGo and Code Pro. [API](https://inference-docs.cerebras.ai/api-reference/chat-completions), [cache](https://inference-docs.cerebras.ai/capabilities/prompt-caching), [pricing](https://www.cerebras.ai/pricing), [Code plan](https://www.cerebras.ai/code). |
| OpenRouter | Generic OpenAI fields; documented `prompt_tokens_details.cache_write_tokens` also subtracted from prompt, floored at zero. **Assumed: details fields are a breakdown of prompt_tokens (writes included)**. Cache/reasoning inclusion otherwise uses **assumed (OpenAI field semantics)**. | Automatic final-chunk usage; `include_usage` is deprecated. **No universal implicit cache claim**: depends on routed model/provider. | `metered_api`. [API](https://openrouter.ai/docs/api_reference/overview), [usage](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [cache](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [pricing](https://openrouter.ai/pricing). |
| Meta | Chat/Responses generic OpenAI usage fields; cached/reasoning inclusion is **assumed (OpenAI field semantics)**. No documented write count. | **Implicit prefix cache**, no flag required. Protocol-dependent usage location. | `metered_api` for Model API, not the separate Muse Code subscription. [cache and usage fields](https://dev.meta.ai/docs/prompt-caching), [Responses](https://dev.meta.ai/docs/protocols/responses), [pricing](https://dev.meta.ai/docs/pricing-rate-limits). |
| OpenCode Go / Zen | Prefer `opencode.tokens.{input,cache_read,cache_write_5m,cache_write_1h,output,reasoning}`. Input already excludes reads and writes; output includes reasoning. Report both write lifetimes plus their sum. Generic OpenAI fallback is **assumed (OpenAI field semantics)**. | Chat's final usage chunk needs opt-in; Responses uses `response.completed`. Automatic caching **UNSTATED**, so no implicit claim. | Go omitted: allowance plus optional PayGo Extra Usage share a key. Zen `metered_api`. [inference API](https://opencode.ai/v2/docs/console/api/inference/), [Go](https://opencode.ai/docs/go/), [Zen](https://opencode.ai/docs/zen/). |
| Ollama Cloud | Cloud `/v1` usage details **UNSTATED**; generic OpenAI fields are **assumed (OpenAI field semantics)** when present. Do not borrow native `/api/chat`'s `prompt_eval_count` / `eval_count`. | Supports Chat `include_usage`; requirement and automatic cache for Cloud `/v1` **UNSTATED**. | Omitted: generic key spans pay-as-you-go and Pro/Max included credits. [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [pricing](https://ollama.com/pricing). |
| xAI | Responses `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` (Chat equivalents also accepted). Inclusion is **assumed (OpenAI field semantics)**. | Usage is taken from the terminal response object, including the frames already observed on WebSocket. **Implicit prefix cache**. | `metered_api`. [Responses](https://docs.x.ai/docs/api-reference#responses), [automatic caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching), [cache usage](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing), [pricing](https://docs.x.ai/developers/pricing). |
| Fireworks | `prompt_tokens`, `completion_tokens`; cache read from final chunk's **`perf_metrics.cached-prompt-tokens`**, falling back to standard cached detail. Prompt includes cache. Standard reasoning detail is **assumed (OpenAI field semantics)** if present. No documented write count. | Usage included by default. Cache metrics require `perf_metrics_in_response`, which the plugin **does not add**; without them input may include cache hits. **Implicit cache**. | `metered_api`. [Chat API](https://docs.fireworks.ai/api-reference/post-chatcompletions), [cache](https://docs.fireworks.ai/guides/prompt-caching), [pricing](https://docs.fireworks.ai/serverless/pricing). |
| Inception | `prompt_tokens`, `completion_tokens` (includes reasoning). Accept `cached_input_tokens` or standard cached detail; `reasoning_tokens` or standard reasoning detail. Cache subtraction is **assumed (OpenAI field semantics)**. No documented write count. | Final usage-only chunk requires `include_usage`. Automatic cache **UNSTATED**. | `metered_api`. [API (both spellings)](https://docs.inceptionlabs.ai/api-reference/chat/create-a-chat-completion), [pricing](https://docs.inceptionlabs.ai/get-started/models.md). |
| Kimi Code | Kimi Chat fields: prompt includes cached reads **and** `prompt_tokens_details.cache_write_tokens`; completion includes standard reasoning detail. Cache-read and reasoning inclusion **verified live** for Code model `k3` on 2026-11-11. Cache-write inclusion remains **assumed applicable to Code plan** from regular Kimi Chat docs, not Code's endpoint page. | Final usage chunk requires `include_usage`. **Implicit cache**, also **assumed for the Code plan endpoint**. | `subscription_included` for the membership key, not a Platform key. [Code](https://www.kimi.com/code/docs/en), [Chat API](https://platform.moonshot.ai/docs/api/chat), [cache](https://platform.kimi.ai/docs/guide/context-caching). |
| Cline Pass | `prompt_tokens`, `completion_tokens`, standard cached detail. Generic reasoning detail, when present, and inclusion semantics are **assumed (OpenAI field semantics)**. | Exact usage opt-in requirement and automatic cache **UNSTATED**. | `subscription_included`: reference API rates are not per-request charges. [Chat API](https://docs.cline.bot/api/chat-completions.md), [ClinePass pricing](https://docs.cline.bot/getting-started/clinepass.md). |
| TypeSafe | Non-streaming JSON `usage.input_tokens` / `output_tokens`; no cache or reasoning fields claimed. | System One documents JSON, not a streamed usage contract. Automatic cache **UNSTATED**. | `metered_api`: API input tokens are billable. [System One](https://docs.typesafe.ai/api/system-one.md). |
| MiniMax Coding Plan | Generic OpenAI fields; standard cached detail documented. Reasoning detail and inclusion are **assumed (OpenAI field semantics)** if present; no guessed nonstandard write count. | **Implicit repeated-context cache**. | `subscription_included` for M Plan key, distinct from regular pay-as-you-go key. [Chat](https://platform.minimax.io/docs/api-reference/text-chat-openai.md), [cache](https://platform.minimax.io/docs/api-reference/text-prompt-caching.md), [plan key](https://platform.minimax.io/docs/m-plan/quickstart.md). |
| Synthetic | Documented `prompt_tokens`, `completion_tokens`; generic standard cache/reasoning fields, if present, are **assumed (OpenAI field semantics)**. | Opt-in requirement and automatic cache **UNSTATED**. | Omitted: subscription credits and usage-based requests/top-ups can share a key. [Chat](https://dev.synthetic.new/docs/openai/chat-completions), [pricing](https://synthetic.new/pricing), [model pricing](https://synthetic.new/pricing/models). |

## Live evidence: 2026-11-11, OpenCode 2.2.3

The operator's `billing-run-1111b.log` captures the `--billing` mode against real
vault-served providers on **2026-11-11**, using **OpenCode 2.2.3**. These results
verify the listed models and fields, not every model or protocol a provider
offers. The two long prompts used fresh sessions with the same model/variant,
default agent and working directory; matching stored context totals are shown
below. This run does not establish cache-write semantics.

### Verified live

OpenCode's AI SDK stores visible output separately from reasoning. The report's
`output - reasoning` therefore matches stored `output` when reasoning is included
in the report's output. The original capture marked these reasoning turns FAIL
because its chars/4 heuristic underestimated short replies; the measured token
counts below establish inclusion instead.

| Provider / model | Prompt includes cached reads | Output includes reasoning |
| --- | --- | --- |
| DeepSeek / `deepseek-flash` | **Verified:** first input **8281 = 217 + 8064** (second input + cache read). Stored context was 8281 on both long turns. | **Verified:** report output **43 - 41** reasoning **= 2** stored visible output. |
| Kimi Code / `k3` | **Verified:** first input **7709 = 0 + 7709** (second input + cache read). Stored context was 7709 on both long turns. | **Verified:** report output **53 - 39** reasoning **= 14** stored visible output. |
| Cerebras / `qwen-3.8-27b` | **Untested:** both fresh-session long turns reported cache read 0, with input/context 8567 each. No cache hit was observed. | **Verified:** report output **133 - 128** reasoning **= 5** stored visible output. |

All three providers supplied input and output usage on all three completed
reports. These observations supplement the documentation sources above.

### Still assumed, untested

Cache/reasoning inclusion remains assumed where the table marks it as such:

- **OpenRouter:** `cohere/north-mini-code:free` gave no cache hit. The first
  completed report had input 7803, output 1 and cache read/write 0; the second
  completed report carried **no usage**, so usage presence failed and inclusion
  could not be verified. OpenCode's stored zeroes on that second turn are not
  measured provider usage.
- **Fireworks:** provider-side HTTP **412** refusal.
- **Cline Pass:** provider-side HTTP **404** refusal.
- **Ollama Cloud:** provider-side HTTP **402** refusal.
- **Meta:** provider-side HTTP **403** refusal.
- **xAI:** provider-side HTTP **403** refusal (HTTP fallback was logged).
- **opencode-go:** provider-side HTTP **429** refusal.

Refusals do not provide completed usage with which to verify inclusion semantics.

### Not run

- **Inception, MiniMax Coding Plan and Synthetic:** no usable account.
- **TypeSafe:** unknown to this host's catalog.
- **opencode-zen:** not served on this host.

## Host stream options and cache policy

The inspected OpenCode 2 source's openai-compatible protocol
(`packages/ai/src/protocols/openai-chat.ts`, `detectSupportsUsageInStreaming` and
`lowerRequest`) defaults streaming usage support to true and sends
`stream_options: { include_usage: true }`; a model compatibility override can
disable it. The `billing: a real vault-served HTTP turn` case in
`packages/opencode/test/v2/e2e/opencode2.e2e.test.ts` also verifies usage reaches
the plugin on the pinned `@opencode/cli` 2.2.0 host.
Installed pi-ai 1.3.0's `dist/api/openai-completions.js` (`buildParams` and
`getCompat`) likewise adds it unless `supportsUsageInStreaming === false`, with
support enabled for both DeepSeek and Cerebras. These are **host decisions**:
the auth plugin never adds it. A reply without usage still gets a report,
without `usage`.

There is no keep-warm implementation. If the session's current common-auth
`sessionCachePolicy(sessionId)?.keep_warm` is set and not `off`, the report adds
`cache.warming: { on: false, stopReason: 'unsupported' }`. common-auth 0.43.0's
validator accepts warming by itself, without `implicit` or a TTL. Otherwise
warming is omitted. Only the documented-automatic providers in the table get
`cache.implicit: true`; there is no keep-warm traffic or request modification.
