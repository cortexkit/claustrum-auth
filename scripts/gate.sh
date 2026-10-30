#!/usr/bin/env bash
# Linux coverage from .github/workflows/ci.yml; requires Node 24; full mode pins Bun via .mise.toml.
# CI-only: macOS/Windows matrices for check, setup-menu, pi-e2e, opencode1-e2e,
# opencode2-e2e; Windows-only pi-windows-private-files (both Windows images,
# including standard-user provisioning, ACL denial probes and cleanup).
# Checkout/setup-node are prerequisites; full mode bootstraps Bun if needed.
# Each Linux job installs frozen dependencies; one shared install suffices here.
# check: install -> build -> typecheck -> lint -> unit -> ignored-file check.
# The ignored-file check moves into --fast; the other check commands keep CI order.
# The other Linux jobs run their exact test commands/env below after the fast phase.
set -euo pipefail

step=arguments
commit=unknown
logs=
finish() {
  local result=$?
  trap - EXIT
  if [[ -n "$logs" ]]; then rm -rf "$logs"; fi
  if [[ $result -eq 0 ]]; then
    printf 'GATE_OK %s\n' "$commit"
  else
    printf 'GATE_FAILED %s\n' "$step"
  fi
  exit "$result"
}
trap finish EXIT
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --fast ) ]]; then
  printf 'Usage: scripts/gate.sh [--fast]\n' >&2
  exit 2
fi
fast=${1:-}
step=checkout
cd "$(dirname "${BASH_SOURCE[0]}")/.."
commit=$(git rev-parse HEAD)
if [[ $fast != --fast && $(uname -s) != Linux ]]; then
  step=linux-runner
  printf 'Run the full gate with AFT runon: "linux,16c,net"; use --fast on macOS.\n' >&2
  exit 2
fi

run_step() {
  step=$1
  shift
  printf '\n== %s ==\n' "$step"
  "$@"
}
ignored_files() {
  local tracked
  tracked=$(git ls-files -ci --exclude-standard -- .cortexkit)
  test -z "$tracked" || { printf '%s\n' "$tracked"; return 1; }
}

if [[ $fast != --fast ]]; then
  step=toolchain
  pinned_bun=$(sed -n 's/^bun = "\([^"]*\)"$/\1/p' .mise.toml)
  if [[ -z "$pinned_bun" ]]; then
    printf 'Cannot read the Bun pin from .mise.toml.\n' >&2
    exit 1
  fi
  bun_version=$(bun --version 2>/dev/null || true)
  if [[ $bun_version != "$pinned_bun" ]]; then
    tools="$PWD/target/scratch/gate-tools"
    printf 'Bun on PATH is %s; fetching pinned Bun %s into %s.\n' "${bun_version:-unavailable}" "$pinned_bun" "$tools"
    if ! npm install --prefix "$tools" --no-save --package-lock=false "bun@$pinned_bun"; then
      printf 'Cannot obtain pinned Bun %s: npm install failed in %s (see npm output above).\n' "$pinned_bun" "$tools" >&2
      exit 1
    fi
    export PATH="$tools/node_modules/.bin:$PATH"
    hash -r
    bun_version=$(bun --version 2>/dev/null || true)
  fi
  if [[ $bun_version != "$pinned_bun" ]]; then
    printf 'Cannot use pinned Bun %s: selected Bun reports %s.\n' "$pinned_bun" "${bun_version:-unavailable}" >&2
    exit 1
  fi
  printf 'Using Bun %s (%s).\n' "$bun_version" "$(command -v bun)"
fi

# Do not inherit opt-ins from an operator's shell: CI scopes them per suite.
# Live smoke and the Windows second-user probe are not Linux CI steps.
unset CLAUSTRUM_AUTH_OPENCODE1_E2E CLAUSTRUM_AUTH_OPENCODE2_E2E
unset CLAUSTRUM_AUTH_PI_E2E CLAUSTRUM_AUTH_SETUP_E2E
unset CLAUSTRUM_AUTH_LIVE_SMOKE_E2E CLAUSTRUM_AUTH_PI_SECOND_USER
# Stable, uncolored Bun summaries allow each suite's counts to be checked below.
export NO_COLOR=1
run_step frozen-lockfile bun install --frozen-lockfile
# build includes installed ranges, static entries, externals, lazy chunks and package contents.
run_step build bun run build
run_step typecheck bun run typecheck
# Biome checks formatting as well as lint; lint also checks source portability.
run_step lint bun run lint
run_step ignored-cortexkit ignored_files
if [[ $fast == --fast ]]; then exit 0; fi

step=suite-logs
mkdir -p target/scratch
logs=$(mktemp -d "$PWD/target/scratch/gate.XXXXXX")
names=()
pids=()
launch() {
  local name=$1
  shift
  names+=("$name")
  "$@" >"$logs/$name.log" 2>&1 &
  pids+=("$!")
}
failed=
collect() {
  local i name result line count kind pass fail skip
  for ((i=0; i<${#names[@]}; i++)); do
    name=${names[$i]}
    if wait "${pids[$i]}"; then result=0; else result=$?; fi
    printf '\n== %s ==\n' "$name"
    cat "$logs/$name.log"
    pass=unknown fail=unknown skip=0
    while IFS= read -r line; do
      if [[ $line =~ ^[[:space:]]*([0-9]+)[[:space:]]+(pass|fail|skip)$ ]]; then
        count=${BASH_REMATCH[1]} kind=${BASH_REMATCH[2]}
        case $kind in pass) pass=$count ;; fail) fail=$count ;; skip) skip=$count ;; esac
      fi
    done <"$logs/$name.log"
    printf 'SUITE %s pass=%s fail=%s skip=%s exit=%s\n' "$name" "$pass" "$fail" "$skip" "$result"
    # A crash or an empty selection must not look like a green test suite.
    if [[ $result -ne 0 || $pass == unknown || $pass == 0 || $fail != 0 ]]; then
      if [[ -z "$failed" ]]; then failed=$name; fi
    fi
  done
  names=() pids=()
}
opencode2() {
  cd packages/opencode
  CLAUSTRUM_AUTH_OPENCODE2_E2E=1 bun test --timeout 600000 test/v2/e2e/opencode2.e2e.test.ts
}

# These four CI jobs have independent fixtures and can share a checkout.
launch unit bun run test
launch pi-e2e env CLAUSTRUM_AUTH_PI_E2E=1 bun test packages/pi/test
launch opencode1-e2e env CLAUSTRUM_AUTH_OPENCODE1_E2E=1 bun test packages/opencode/test/opencode1.e2e.test.ts --timeout 600000
launch opencode2-e2e opencode2
collect
# Setup rebuilds shared setup/Pi fixtures and may install the same OpenCode 1 host.
# Wait for the parallel wave so it cannot delete bundles another suite is using.
launch setup-menu env CLAUSTRUM_AUTH_SETUP_E2E=1 CLAUSTRUM_AUTH_OPENCODE1_E2E=1 CLAUSTRUM_AUTH_OPENCODE2_E2E=1 CLAUSTRUM_AUTH_PI_E2E=1 \
  bun test packages/opencode/test/opencode1.e2e.test.ts packages/opencode/test/v2/e2e/opencode2.e2e.test.ts packages/pi/test/extension.e2e.test.ts --test-name-pattern 'setup test build' --timeout 600000
collect
if [[ -n "$failed" ]]; then step=$failed; exit 1; fi
