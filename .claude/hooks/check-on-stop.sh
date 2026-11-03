#!/usr/bin/env bash
# Stop. Runs scripts/comprobar.sh --quick before Claude ends a turn. On a failure,
# exit code 2 sends Claude back to work with the output.
#
# The engine's suite is slow, so each state of the working tree is checked once.
# A second stop on the same state lets Claude end the turn and report what is
# still failing, and a run cut off by the hook's timeout is not repeated.
# Checks that could not run here (exit code 3) do not block.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || exit 0
[ -f scripts/comprobar.sh ] || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

state_file="$(git rev-parse --git-path comprobar-last-state)"
state="$({
  git rev-parse HEAD
  git diff HEAD
  git ls-files --others --exclude-standard -z | xargs -0 git hash-object -- 2>/dev/null
} | git hash-object --stdin)"

[ "$(cat "$state_file" 2>/dev/null)" = "$state" ] && exit 0
printf '%s\n' "$state" >"$state_file"

output="$(bash scripts/comprobar.sh --quick 2>&1)"
status=$?
if [ "$status" -eq 1 ]; then
  {
    echo "scripts/comprobar.sh --quick failed. Fix what this change broke; report anything that was already failing. Output:"
    printf '%s\n' "$output" | tail -n 120
  } >&2
  exit 2
fi
exit 0
