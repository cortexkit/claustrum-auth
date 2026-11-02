# Standing rules for workers

Standing rules for workers. Anything not listed here comes to the head (OAIAUTH) as a question.

## Build and test
- Run only the tests for the files and behaviour you changed, by file or by name (`bun test <file> -t <name>`, with the matching e2e flag when you changed a host path), plus `scripts/gate.sh --fast`, which runs the seconds-long checks locally; run it before every commit and report its final line and wall time. For a bug fix, show one test failing without the fix. Run those filtered tests on the build server through the AFT `bash` tool's `runon` parameter (`runon: "linux,4c"`; add `,net` when the test installs), or on the Mac when they need macOS or something the build server can't install (an unpublished candidate tarball).
- Remote Linux jobs cannot change files git tracks (writes, deletes, `sed -i`, formatter rewrites all fail with "Operation not permitted"). Show a fix failing without it locally, or in a scratch copy under `$TMPDIR`, never by reverting a tracked file inside a job. Regenerate tracked fixtures locally, or name them in `runon` `return_paths`.
- Never run a whole package suite or the full gate (`scripts/gate.sh` without `--fast`); the head runs the full gate once over several merged deliveries. If a test outside your change looks broken, rerun only that test by name on the base commit, never the suite. A filtered run that takes more than about 15 minutes means the filter is too broad: narrow it rather than wait.
- Use Node 24 (as in CI). For reference, the head's full gate (`linux,8c,net`) uses the Bun pin in `.mise.toml`: if Bun on PATH differs or is missing, it fetches the pin with npm into ignored `target/scratch/gate-tools`, prepends its bin directory to PATH, and refuses to continue if the pin cannot be obtained and verified. No hand-installed Bun is needed for the full gate. `--fast` keeps the developer's Bun on PATH without bootstrapping or enforcing the pin. Install with `bun install --frozen-lockfile`. `bun run build` checks installed ranges, then builds the three workspaces (`packages/core`, `packages/opencode`, `packages/pi`) in order and checks static entry imports, externals, lazy chunks and package contents. `bun run lint` includes formatting and portability; `bun run typecheck` covers the root and all three workspaces.
- The full gate runs the unit suite and the real pinned hosts with `CLAUSTRUM_AUTH_OPENCODE1_E2E=1`, `CLAUSTRUM_AUTH_OPENCODE2_E2E=1`, `CLAUSTRUM_AUTH_PI_E2E=1`, and the setup-menu suite with `CLAUSTRUM_AUTH_SETUP_E2E=1` plus all three host flags. Keep flags scoped to their CI commands. Live smoke is not in CI and must not be enabled by the gate.
- Show each fix's test failing without the fix (revert the fix, run the test, restore it), and quote the failure line in the report.
- Windows and the macOS matrix jobs run in CI only. If a change touches file permissions, locks, paths or process spawning, say so in the report, so the head runs the Windows workflow before merging.

## Report-only tasks
- A task that only writes a report under `.cortexkit/internal-docs/` changes no product code: skip the gate, commit nothing, and deliver with the existing HEAD. The report reaches the head when the task is settled.

## Pre-approved (do it, then report it)
- Regenerate `bun.lock` after a manifest change you were asked to make.
- Add test seams and test-only helpers, kept out of the published types.
- Format with Biome, and fix lint in files you touch.
- Update docs and comments that describe behaviour you changed.
- Fix a test whose expectation contradicts the brief, and say why in the report.
- Merge `main` into your branch when it moved, keeping both sides.

## Never
- Loosen an assertion, skip a test, or raise a timeout without phase-clock evidence of where the time goes.
- Commit a candidate tarball path, or force-add anything under `.cortexkit/` other than this file. Add this file normally; `.gitignore` already allows it.
- Read or write the operator's real config, OpenCode or Pi folders, or vault. Tests use temporary homes and isolated host profiles; preserve the existing harness isolation.
- Invent provider addresses or infer them from fixtures. Use only provider API docs or the pinned catalogs/host drivers cited in `docs/providers.md`; cite the source for changes and preserve exact-origin matching (scheme, host and port).
- Push, tag, publish, or post on GitHub.
- Change these without asking: user-visible wording beyond the brief, config keys, stored formats or migrations, what reaches a provider or the vault, security boundaries.

## Comments
Explain the reason for a reader with no context. No task ids, slice names or references to this conversation.
