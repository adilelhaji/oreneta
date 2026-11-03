#!/usr/bin/env bash
# Runs on this machine the checks that CI runs (.github/workflows/test.yml).
# It calls the same commands and adds no threshold of its own. The one local
# extra is prettier, which CLAUDE.md asks for and test.yml does not run. It
# installs nothing: a missing tool or dependency folder is reported as NOT RUN.
# A missing system library or SDK makes its check fail instead.
#
#   scripts/comprobar.sh           every area, without Docker or a browser
#   scripts/comprobar.sh --quick   only the areas changed against origin/main,
#                                  core commands only (used by the Stop hook)
#   scripts/comprobar.sh --full    also Playwright and the integration suite
#
# Exit code: 0 everything ran and passed
#            1 at least one check failed
#            3 nothing failed, but some checks could not run here
#
# CI only: go-windows, linux-native, macos-native, POP3 against Dovecot, chat
# against Prosody, the Flatpak metainfo check, the scan of the distributable
# binary for inherited OAuth values, the repeat of the IDLE test and the coverage
# artifacts. CI also fetches the translation test model: without it in
# frontend/.translation-models, the tests that need it are skipped here.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

mode="default"
case "${1:-}" in
  "") ;;
  --quick) mode="quick" ;;
  --full) mode="full" ;;
  *)
    echo "usage: scripts/comprobar.sh [--quick|--full]" >&2
    exit 64
    ;;
esac

# Never download a Go toolchain.
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"

passed=""
failed=""
not_run=""

step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  if "$@"; then
    passed="$passed  ok       $name"$'\n'
  else
    failed="$failed  FAILED   $name"$'\n'
  fi
}

skip() {
  echo
  echo "==> NOT RUN: $1 ($2)"
  not_run="$not_run  NOT RUN  $1: $2"$'\n'
}

in_dir() {
  local dir="$1"
  shift
  (cd "$dir" && "$@")
}

# Not ready means the toolchain go.mod requires is not here. Any other error, such
# as a broken go.mod, is left for `go test` to report as a failure.
go_ready() {
  command -v go >/dev/null 2>&1 || return 1
  local output
  output="$(go list -m 2>&1)" && return 0
  case "$output" in
    *"requires go"* | *toolchain*) return 1 ;;
  esac
  return 0
}

# Which areas to check.
want_policy=1 want_go=1 want_rust=1 want_frontend=1 want_mobile=1
if [ "$mode" = "quick" ]; then
  want_policy=0 want_go=0 want_rust=0 want_frontend=0 want_mobile=0
  # Without a base to compare with, check every area.
  if ! git merge-base origin/main HEAD >/dev/null 2>&1; then
    echo "comprobar.sh: no merge base with origin/main, checking every area"
    want_go=1 want_rust=1 want_frontend=1
  fi
  changed="$({
    git diff --name-only origin/main...HEAD 2>/dev/null
    git diff --name-only HEAD 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u)"
  if [ -z "$changed" ] && [ "$want_go$want_rust$want_frontend" = "000" ]; then
    echo "comprobar.sh: nothing changed against origin/main"
    exit 0
  fi
  want_policy=1
  while IFS= read -r file; do
    case "$file" in
      *.go | go.mod | go.sum) want_go=1 ;;
      meron-core/* | third_party/*) want_rust=1 ;;
      frontend/* | locales/* | scripts/i18n/* | package.json | bun.lock) want_frontend=1 ;;
    esac
  done <<<"$changed"
fi

if [ "$want_policy" = "1" ]; then
  if command -v node >/dev/null 2>&1; then
    step "workflow policy" node --test scripts/ci/*.test.cjs
  else
    skip "workflow policy" "node is not installed"
  fi
  if command -v python3 >/dev/null 2>&1; then
    step "translation model mirror" python3 scripts/translation-models/test_mirror.py
  else
    skip "translation model mirror" "python3 is not installed"
  fi
fi

if [ "$want_go" = "1" ]; then
  if go_ready; then
    go_tags=""
    [ "$(uname -s)" = "Linux" ] && go_tags="webkit2_41"
    # go:embed needs frontend/dist to exist, as in CI. It is gitignored.
    [ -d frontend/dist ] || { mkdir -p frontend/dist && touch frontend/dist/placeholder; }
    step "go test" go test -tags "$go_tags" ./...
    if [ "$mode" != "quick" ]; then
      step "go distributable tests" \
        go test -tags "${go_tags:+$go_tags }distributable" -run 'OAuth|Distributable' -count=1 .
    fi
  else
    skip "go" "go is missing or older than go.mod requires"
  fi
fi

if [ "$want_rust" = "1" ]; then
  if command -v cargo >/dev/null 2>&1; then
    step "cargo test" cargo test --manifest-path meron-core/Cargo.toml
    if [ "$mode" != "quick" ]; then
      step "vendored imap-proto" cargo test --manifest-path third_party/imap-proto/Cargo.toml
      step "patched tokio-xmpp" cargo test --manifest-path third_party/tokio-xmpp/Cargo.toml --no-default-features --locked
      for zone in Asia/Tokyo America/Los_Angeles Pacific/Auckland; do
        step "calendar tests in $zone" env TZ="$zone" \
          cargo test --manifest-path meron-core/Cargo.toml --lib -- calendar:: pim::reminders::
      done
    fi
  else
    skip "rust" "cargo is not installed"
  fi
fi

frontend_ready=0
if [ "$want_frontend" = "1" ] || [ "$mode" = "full" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    skip "frontend and localization" "bun is not installed"
  elif [ ! -d node_modules ] || [ ! -d frontend/node_modules ]; then
    skip "frontend and localization" "run bun install in the root and in frontend/"
  else
    frontend_ready=1
  fi
fi

if [ "$want_frontend" = "1" ] && [ "$frontend_ready" = "1" ]; then
  # Typecheck needs the generated catalogs, which are gitignored.
  step "generate catalogs" bun scripts/i18n/catalog.ts generate
  step "validate catalogs" bun scripts/i18n/catalog.ts validate
  step "catalog tests" bun test scripts/i18n/catalog.test.ts
  step "typecheck" in_dir frontend bun run typecheck
  step "prettier" in_dir frontend bun run format:check
  step "frontend tests" in_dir frontend bun test
  if [ "$mode" != "quick" ]; then
    calendar_tests="src/lib/agenda.test.ts src/components/chat/SidebarAgenda.test.tsx src/lib/dayPanel.test.ts src/components/chat/SidebarDay.test.tsx"
    for zone in America/Sao_Paulo Australia/Sydney; do
      # shellcheck disable=SC2086 # the list is meant to split into paths
      step "agenda tests in $zone" in_dir frontend env TZ="$zone" bun test $calendar_tests
    done
    step "drag tests in Europe/Madrid" in_dir frontend env TZ=Europe/Madrid bun test src/lib/calendarDrag.test.ts
    step "bundler checks" in_dir frontend bun run test:bundler
  fi
fi

if [ "$want_mobile" = "1" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    skip "mobile" "the Gradle build runs the localization scripts through bun"
  else
    java_major="$(java -version 2>&1 | sed -nE '1s/.*version "([0-9]+).*/\1/p')"
    if [ "${java_major:-0}" -lt 21 ]; then
      skip "mobile" "CI uses Java 21, found ${java_major:-none}"
    elif [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ] && ! grep -qs '^sdk.dir=' mobile/local.properties; then
      skip "mobile" "no Android SDK found"
    else
      step "mobile tests" ./mobile/gradlew -p mobile :shared:allTests :ui:allTests
    fi
  fi
fi

if [ "$mode" = "full" ]; then
  if [ "$frontend_ready" = "1" ]; then
    step "baseline" in_dir frontend bun run baseline:verify
    step "startup and axe audits" in_dir frontend bun run startup:verify
  fi
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    skip "integration" "Docker is not running"
  elif ! command -v cargo >/dev/null 2>&1 || ! go_ready; then
    skip "integration" "needs cargo and a current go"
  else
    step "build engine" cargo build --manifest-path meron-core/Cargo.toml
    step "integration" env MERON_KEYRING=off go test -tags "integration${go_tags:+ $go_tags}" -count=1 -timeout 10m .
  fi
fi

echo
echo "--- summary ($mode) ---"
printf '%s%s%s' "$passed" "$not_run" "$failed"
[ "$mode" = "default" ] && echo "  left out: Playwright and the integration suite (use --full)"
[ "$mode" = "quick" ] && echo "  left out: areas not changed, mobile, repeat runs in other time zones"

if [ -n "$failed" ]; then
  echo "comprobar.sh: FAILED"
  exit 1
fi
if [ -n "$not_run" ]; then
  echo "comprobar.sh: INCOMPLETE, nothing failed but some checks could not run"
  exit 3
fi
echo "comprobar.sh: all checks passed"
exit 0
