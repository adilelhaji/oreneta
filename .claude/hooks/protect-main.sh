#!/usr/bin/env bash
# PreToolUse (Bash). Exit code 2 blocks git commands that admit no exception:
# pushing to main, force pushing, --no-verify, deleting main, and a hard reset
# to origin/main. It matches the command text, so a command that merely quotes
# one of these (a commit message, say) is blocked too: reword it.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command_text="$(bash "$here/read-field.sh" .tool_input.command)"
[ -z "$command_text" ] && exit 0

block() {
  echo "Blocked by .claude/hooks/protect-main.sh: $1. Command: $command_text" >&2
  exit 2
}

# One line, single spaces, and without `git -C dir` or `git -c key=value`.
flat="$(printf '%s' "$command_text" | tr -s '[:space:]' ' ' | sed -E 's/git( -[cC] [^ ]+)+ /git /g')"
matches() { printf '%s' "$flat" | grep -Eq "$1"; }

if matches 'git push[^;&|]* (-[a-zA-Z]*f[a-zA-Z]*|--force[a-z-]*)( |$|[;&|])' || matches 'git push[^;&|]* \+[^ ]+'; then
  block "no force push"
fi
if matches 'git push[^;&|]* (refs/heads/)?(main|master)( |$|:|[;&|])' || matches 'git push[^;&|]*:(refs/heads/)?(main|master)( |$|[;&|])'; then
  block "no push to main: use a branch and a pull request"
fi
# `git push` or `git push origin [HEAD]` publishes the current branch.
if matches 'git push( -[^ ]+)*( [^- ;&|][^ ;&|]*)?( HEAD)?( *$| *[;&|])'; then
  case "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" in
    main | master) block "no push to main: this checkout is on main" ;;
  esac
fi
if matches 'git (commit|push)[^;&|]* --no-verify'; then
  block "no --no-verify"
fi
if matches 'git branch[^;&|]* (-[dD]|--delete)( -[^ ]+)* (main|master)( |$|[;&|])'; then
  block "main is not deleted"
fi
if matches 'git reset[^;&|]* --hard[^;&|]*origin/(main|master)'; then
  block "no hard reset to origin/main: start a new branch instead"
fi
exit 0
