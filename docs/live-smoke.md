# Live smoke: a real vault key through each served provider

The design (section 14.4, step 6) asks for one operator-run smoke per provider
and host: a real turn against the provider, with a key served from the real
vault, on Windows and on macOS or Linux. CI cannot do this, because it needs a
vault key and an enrolled host, so this page is the script for the run.

Record the result in the provider batch's slice report: host, OS, provider,
the turn's output and the `/claustrum` status line.

## 0. Once, before the first provider

1. Install the published packages, or a packed build of this branch:
   `@cortexkit/opencode-claustrum-auth` and `@cortexkit/pi-claustrum-auth`.
   The setup command is the `claustrum-auth` bin of the OpenCode package.
2. Run setup and approve the enrollment, then grant the category:

   ```sh
   claustrum-auth setup --claustrum
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
   below). `docs/providers.md` lists the rows this batch needs and the two rows
   the vault metadata currently blocks.

## OpenCode 2

Command per provider (the method id is `claustrum-auth`):

| provider | activation |
| --- | --- |
| cerebras | `opencode auth login cerebras --method claustrum-auth` |
| deepseek | `opencode auth login deepseek --method claustrum-auth` |
| fireworks | `opencode auth login fireworks-ai --method claustrum-auth` |
| inception | `opencode auth login inception --method claustrum-auth` |
| cline-pass | `opencode auth login cline-pass --method claustrum-auth` |
| kimi-coding | `opencode auth login kimi-for-coding --method claustrum-auth` |
| openrouter | `opencode auth login openrouter --method claustrum-auth` |
| typesafe | `opencode auth login typesafe --method claustrum-auth` |

Steps, per provider:

1. Start OpenCode 2. Run `/claustrum status`: the provider appears with its
   state, and `/claustrum refusals` does not list its credential. A refusal
   there names the fix (`not-on-this-host`, `host-id-missing`,
   `unsupported-provider`, `unmapped`).
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
| kimi-coding | `/claustrum use kimi-for-coding` |
| openrouter | `/claustrum use openrouter` |
| typesafe | `/claustrum use typesafe` |

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

typesafe, inception and cline-pass are not listed on Pi: Pi's catalog has no
inception or cline-pass provider at all, and it registers typesafe with an api
that does not go through the plugin's fetch (`docs/providers.md`).

Steps, per provider:

1. Run `/claustrum` and check the provider's state. `/claustrum refusals`
   should not list its credential; `apikey:fireworks-ai` shows
   `host-id-missing` here until the row also names `fireworks`.
2. Run the activation command above. **Pass:** Pi asks for consent to move the
   existing login aside (when there is one), you accept, and the provider is
   reported as owned.
3. Choose a model of that provider and send one short prompt. **Pass:** a
   normal answer arrives. With fireworks, remember that the owned form hides
   the provider's `anthropic-messages` models; the count is in
   `/claustrum`'s provider line.
4. Run `/claustrum` again. **Pass:** the provider line says owned with one
   vault account.
5. Run `/claustrum release <provider>`. **Pass:** your own Pi login is back and
   a prompt with it answers.

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
