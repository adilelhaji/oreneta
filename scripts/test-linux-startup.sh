#!/usr/bin/env bash
# Native Linux startup check (#115): the production desktop binary, launched
# twice in a fresh profile under Xvfb with WebKitGTK, must start its core and
# have the React app in the webview talk to it (its first commands are in the
# log), under the production Content-Security-Policy. A screenshot of each
# launch is kept as evidence. This is a regression check for Linux, not
# evidence of macOS or Windows parity.
#
#   bash scripts/test-linux-startup.sh build/bin/oreneta native-startup-linux
#
# MERON_CORE_SERVER may point at the core binary when it is not bundled.
set -euo pipefail
BIN=$(readlink -f "$1")
OUT=$2
mkdir -p "$OUT"
OUT=$(readlink -f "$OUT")
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT

for launch in 1 2; do
  LOG="$PROFILE/config/oreneta-dev/oreneta.log"
  [ -f "$LOG" ] && mv "$LOG" "$OUT/before-launch-$launch.log"
  xvfb-run -a -s "-screen 0 1280x800x24" bash -c '
    set -u
    env HOME="$0/home" XDG_CONFIG_HOME="$0/config" XDG_CACHE_HOME="$0/cache" XDG_DATA_HOME="$0/data" \
        MERON_KEYRING=off MERON_DISABLE_SELF_UPDATE=1 devserver=native-startup-test frontenddevserverurl= \
        "$1" >"$2/launch-$3-stdout.log" 2>&1 &
    app=$!
    log="$0/config/oreneta-dev/oreneta.log"
    ok=0
    for _ in $(seq 1 160); do
      if ! kill -0 "$app" 2>/dev/null; then echo "launch $3: the app exited" >&2; break; fi
      if [ -f "$log" ] && grep -q "core started" "$log" && grep -q "invoke .* ok after" "$log"; then ok=1; break; fi
      sleep 0.25
    done
    sleep 2
    import -window root "$2/launch-$3.png" 2>/dev/null || true
    kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
    cp "$log" "$2/launch-$3.log" 2>/dev/null || true
    [ "$ok" = 1 ]
  ' "$PROFILE" "$BIN" "$OUT" "$launch" || { echo "FAIL launch $launch (see $OUT)" >&2; exit 1; }
  if grep -q "core failed to start" "$OUT/launch-$launch.log"; then echo "FAIL launch $launch: core failed" >&2; exit 1; fi
  if grep -qi "Something went wrong" "$OUT/launch-$launch-stdout.log"; then echo "FAIL launch $launch: UI error" >&2; exit 1; fi
  echo "PASS launch $launch: core started and the webview called it ($(grep -c 'invoke .* ok after' "$OUT/launch-$launch.log") commands)"
done
