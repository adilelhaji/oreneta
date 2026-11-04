#!/usr/bin/env bash
# Prints one field of the JSON that Claude Code passes to a hook on stdin.
# Usage: value="$(printf '%s' "$json" | read-field.sh .tool_input.command)"
# Tries jq, then python3, then node. Prints nothing if none is available.
field="$1"
if command -v jq >/dev/null 2>&1; then
  jq -r "$field // empty"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
    for part in sys.argv[1].strip(".").split("."):
        value = value.get(part) if isinstance(value, dict) else None
    if value is not None:
        print(value)
except Exception:
    pass
' "$field"
elif command -v node >/dev/null 2>&1; then
  node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
  try {
    let value = JSON.parse(input);
    for (const part of process.argv[1].split(".").filter(Boolean)) value = value?.[part];
    if (value !== undefined && value !== null) console.log(String(value));
  } catch {}
});
' "$field"
fi
