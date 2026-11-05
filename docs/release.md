# Release

This repository uses CortexKit's tag-driven release workflow. One version covers
`@cortexkit/opencode-claustrum-auth` and `@cortexkit/pi-claustrum-auth`.
`@cortexkit/claustrum-auth-core` stays private at its development version: it is
bundled into the public packages, not published or installed by consumers.

## Before the first release

The committed workflow uses **npm Trusted Publishing (OIDC)**.
It uses **no npm secret** (`NPM_TOKEN` and `NODE_AUTH_TOKEN` are not configured).
GitHub's `id-token: write` permission supplies the OIDC identity; its GitHub token
is used only to read CI and create the GitHub release.

**The two absent npm names need bootstrapping before this OIDC workflow can
publish them.** npm explicitly requires the package to already exist when adding
a trusted publisher with [`npm trust`][trust-prerequisites]; the website setup
also starts from the [package's settings][trusted-setup]. Consequently an absent
package cannot yet authorize this workflow with OIDC alone.

The operator must arrange the following (no publishing is done by the tooling
installation itself):

1. Use an npm account authorized to create packages under the **cortexkit npm
   organization**. npm documents [organization-scoped publishing][org-publish]
   and the required [read/write package access][access-matrix]. GitHub org access
   is not npm org access.
2. For an unattended **first publish with provenance**, create a short-lived
   granular access token with **Bypass two-factor authentication** enabled and
   **Packages and scopes: Read and write (publish and stage)** for the
   **`@cortexkit` scope**. The scope selection covers the new package names, which
   cannot yet be selected individually. npm documents [direct publish
   authentication][direct-publish] and [token permissions][tokens]. Token
   **Organizations** permissions manage org settings/teams/users; they do **not**
   grant package publishing rights. Token rights cannot exceed the issuing
   account's rights.
3. Arrange a reviewed, one-time **GitHub-hosted Linux Actions job** in this
   **public repository**. For the first `v0.1.0` tag, let the release script create
   the bump commit and push it with the tag as described below. The initial OIDC
   publish attempt cannot publish the absent names. Run the bootstrap job at
   **that same tag/commit**, after its exact-commit CI has passed. Give the job
   `id-token: write`, Node 24 with `registry-url: https://registry.npmjs.org`, and
   the Bun version in `.mise.toml`. Install frozen dependencies, check
   `node scripts/version-sync.mjs <version> --check`, build, then run:

   ```bash
   npm publish --workspace packages/opencode --provenance --access public
   npm publish --workspace packages/pi --provenance --access public
   ```

   For this separately authorized, one-time bootstrap only, supply the granular
   token to `NODE_AUTH_TOKEN` through an operator-created Actions secret (for
   example `NPM_BOOTSTRAP_TOKEN`). That secret is **not** read by the committed
   release workflow. A local manual first publish does not establish Actions
   provenance. npm requires a [supported cloud-hosted runner, matching public
   `repository` metadata, `id-token: write`, and the explicit first-publish
   `--access public` flag][provenance]. The package manifests already identify
   `https://github.com/cortexkit/claustrum-auth.git` and their workspace directories.
4. On **each** newly created package's npm settings, add a GitHub Actions trusted
   publisher: owner **`cortexkit`**, repository **`claustrum-auth`**, workflow
   filename **`release.yaml`** (not its full path), no environment name. Allow
   direct `npm publish` if npm shows an allowed-actions selector. Revoke the
   bootstrap token and remove its temporary job/secret. Rerun the failed release
   workflow: it skips the already bootstrapped versions and creates the GitHub
   release. Do not move or recreate the tag. Subsequent publishes use OIDC; npm
   [automatically generates provenance][automatic-provenance].

The bootstrap job/credential is deliberately not an automatic fallback in the
release workflow. Arrange and review it with the operator before the first tag;
do not expect a tag alone to publish an unregistered npm name. A workflow rerun
skips versions already on npm, allowing recovery after one package was published
or after both were bootstrapped. Registry failures other than a not-found response
stop publishing instead of being treated as permission to publish.

## Cut a release

Use Node 24, Bun from `.mise.toml`, and an authenticated `gh` CLI (or `GH_TOKEN` /
`GITHUB_TOKEN` with Actions read access). Start with a clean `main`, fetched and
in sync with `origin/main`, and wait for **CI on that exact HEAD** to succeed.

Preview:

```bash
./scripts/release.sh 0.1.0 --dry
```

Only **`--dry`** is accepted. `--dry-run`, an empty extra argument, and every
other extra argument are errors before any git/network operation. Preview uses
the same clean-main, sync and exact-commit CI guards as a real release. It bumps
both public manifests, synchronizes any pinned package install lines in the root
README, package READMEs and `docs/**/*.md`, refreshes workspace versions in
`bun.lock`, and runs `scripts/gate.sh --fast`. It leaves those edits for inspection
and prints the commit/tag/push it would make, but **does not commit, tag or push**.
Inspect `git diff` and restore the version-only changes before a real run; its
clean-tree guard will otherwise refuse them. Failed checks also leave the edits
available for inspection.

Create and push the release:

```bash
./scripts/release.sh 0.1.0
```

The script refuses an existing tag, a dirty tree, a branch other than `main`, a
HEAD different from fetched `origin/main`, or CI that has not passed. It requires
every job/matrix entry from `ci.yml` to have succeeded, including Windows private
file checks. Then it performs the same version sync and fast gate, stages only
release version files, commits `release: v0.1.0`, creates annotated tag `v0.1.0`,
and atomically pushes `main` and the tag. No provider, vault or runtime code is
changed by version sync.

## Watch GitHub Actions

```bash
gh run list --repo cortexkit/claustrum-auth --workflow release.yaml --branch v0.1.0
gh run watch <run-id> --repo cortexkit/claustrum-auth --exit-status
```

The tag points at the **new bump commit**, not the pre-bump HEAD. The release
workflow waits up to 30 minutes for the main-push CI run on that exact tagged
commit, and verifies all required jobs before building or publishing. It retries
transient GitHub API 5xx/429/network errors, but fails immediately on 401/404 and
unsuccessful completed CI. It does not start a replacement CI run.

It verifies the committed versions/install pins against the tag without rewriting
them, installs frozen dependencies, builds both public packages, publishes with
`npm publish --provenance --access public` using OIDC, and creates a GitHub release
with generated notes only after both packages are published. Node 24's bundled
npm is retained: an [independent npm upgrade broke provenance with a missing
`sigstore` module][npm-upgrade-incident], and is unnecessary for OIDC.

Before tagging, run `scripts/gate.sh` on the Linux build server. The gate checks
package allowlists, declared runtime externals, exported files, and clean
consumer installs of both actual tarballs. The consumer imports run on plain Node
without permission to read this checkout's dependencies; required host peers use
the same pinned versions as the host tests. The gate does not enable live
smoke tests that contact real providers or use real vault credentials.

[trust-prerequisites]: https://docs.npmjs.com/cli/v12/commands/npm-trust#prerequisites
[trusted-setup]: https://docs.npmjs.com/trusted-publishers/#step-1-add-a-first-trusted-publisher-on-npmjscom
[org-publish]: https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/
[access-matrix]: https://docs.npmjs.com/package-scope-access-level-and-visibility/#npm-package-access-matrix
[direct-publish]: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/#direct-publishing
[tokens]: https://docs.npmjs.com/creating-and-viewing-access-tokens/#creating-granular-access-tokens-on-the-website
[provenance]: https://docs.npmjs.com/generating-provenance-statements/
[automatic-provenance]: https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation
[npm-upgrade-incident]: https://github.com/cortexkit/openai-auth/commit/ae452b6056f3bd7e3aad48d253b90cb8b9ed4407
