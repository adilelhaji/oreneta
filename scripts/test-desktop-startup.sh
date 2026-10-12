#!/usr/bin/env bash
# Native desktop startup check (#115) for Linux (WebKitGTK under Xvfb) and
# macOS (WKWebView in the runner's logged-in session): the production
# desktop binary, launched twice in a fresh profile, must start its core and
# have the React app in the webview talk to it (its first commands are in
# the log), under the production Content-Security-Policy. A screenshot of
# each launch is kept as evidence. This checks startup only; it is not
# evidence of a platform's feature parity.
#
#   bash scripts/test-desktop-startup.sh build/bin/oreneta native-startup
#
# MERON_CORE_SERVER may point at the core binary when it is not bundled.
set -euo pipefail

# One launch, in the display the platform offers: $1..$5 are profile,
# binary, output folder, launch number and log path.
launch_once() {
  set +e
  mkdir -p "$1/home"
  env HOME="$1/home" XDG_CONFIG_HOME="$1/config" XDG_CACHE_HOME="$1/cache" XDG_DATA_HOME="$1/data" \
      MERON_KEYRING=off MERON_DISABLE_SELF_UPDATE=1 devserver=native-startup-test frontenddevserverurl= \
      "$2" >"$3/launch-$4-stdout.log" 2>&1 &
  app=$!
  ok=0
  for _ in $(seq 1 240); do
    if ! kill -0 "$app" 2>/dev/null; then echo "launch $4: the app exited" >&2; break; fi
    if [ -f "$5" ] && grep -q "core started" "$5" && grep -q "invoke .* ok after" "$5"; then ok=1; break; fi
    sleep 0.25
  done
  sleep 2
  if [ "$(uname)" = Darwin ]; then
    screencapture -x "$3/launch-$4.png" 2>/dev/null || true
  else
    import -window root "$3/launch-$4.png" 2>/dev/null || true
  fi
  kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
  cp "$5" "$3/launch-$4.log" 2>/dev/null || true
  [ "$ok" = 1 ]
}

if [ "${1:-}" = --launch ]; then
  shift
  launch_once "$@"
  exit
fi

BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=$2
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT

if [ "$(uname)" = Darwin ]; then
  CONFIG="$PROFILE/home/Library/Application Support"
else
  CONFIG="$PROFILE/config"
fi
LOG="$CONFIG/oreneta-dev/oreneta.log"


for launch in 1 2; do
  [ -f "$LOG" ] && mv "$LOG" "$OUT/before-launch-$launch.log"
  if [ "$(uname)" = Darwin ]; then
    bash "$0" --launch "$PROFILE" "$BIN" "$OUT" "$launch" "$LOG"
  else
    xvfb-run -a -s "-screen 0 1280x800x24" bash "$0" --launch "$PROFILE" "$BIN" "$OUT" "$launch" "$LOG"
  fi || { echo "FAIL launch $launch (see $OUT)" >&2; exit 1; }
  if grep -q "core failed to start" "$OUT/launch-$launch.log"; then echo "FAIL launch $launch: core failed" >&2; exit 1; fi
  if grep -qi "Something went wrong" "$OUT/launch-$launch-stdout.log"; then echo "FAIL launch $launch: UI error" >&2; exit 1; fi
  echo "PASS launch $launch on $(uname): core started and the webview called it ($(grep -c 'invoke .* ok after' "$OUT/launch-$launch.log") commands)"
done
