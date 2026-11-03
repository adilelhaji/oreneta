#!/usr/bin/env bash
# PreToolUse (Bash). Exit code 2 blocks git commands that admit no exception:
# pushing to main, force or mirror pushes, skipping the commit hooks, deleting
# main, a hard reset to origin/main, and writing files through the auto-approved
# `git diff` and `git log`.
#
# It reads the command text, so it guards against mistakes, not against someone
# determined: a command built in a variable or a path with spaces gets past it.
# A line of text that starts like a blocked command is blocked, and so is a commit
# message that mentions --no-verify. Protecting main on GitHub is what really
# enforces this.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command_text="$(bash "$here/read-field.sh" .tool_input.command)"
[ -z "$command_text" ] && exit 0

block() {
  echo "Blocked by .claude/hooks/protect-main.sh: $1. Command: $command_text" >&2
  exit 2
}

is_main() {
  case "$1" in
    main | master | refs/heads/main | refs/heads/master) return 0 ;;
  esac
  return 1
}

cd_dir=""

check_push() {
  local dir="$1" remote_seen=0 refspec_count=0 uses_current=0 skip_next=0 arg destination
  shift
  dir="${dir/#\~/$HOME}"
  for arg in "$@"; do
    if [ "$skip_next" = "1" ]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      --force*) block "no force push" ;;
      --mirror | --all) block "no push of every branch" ;;
      --no-verify) block "no --no-verify" ;;
      -o | --push-option | --repo) skip_next=1 ;;
      --*) ;;
      -*f*) block "no force push" ;;
      -*) ;;
      *)
        if [ "$remote_seen" = "0" ]; then
          remote_seen=1
          continue
        fi
        refspec_count=$((refspec_count + 1))
        case "$arg" in
          +*) block "no force push" ;;
          *'*'*) block "no push of every branch" ;;
          HEAD | @) uses_current=1 ;;
        esac
        destination="${arg##*:}"
        is_main "$destination" && block "no push to main: use a branch and a pull request"
        ;;
    esac
  done
  if [ "$refspec_count" = "0" ] || [ "$uses_current" = "1" ]; then
    is_main "$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)" &&
      block "no push to main: this checkout is on main"
  fi
}

check_commit() {
  local arg short_flags=1
  for arg in "$@"; do
    case "$arg" in
      --no-verify) block "no --no-verify" ;;
      --message | --message=*) short_flags=0 ;;
      --*) ;;
      -u*) ;;
      -*)
        if [ "$short_flags" = "1" ]; then
          case "$arg" in *n*) block "no --no-verify" ;; esac
          # A message follows -m, and its words are not flags.
          case "$arg" in *m*) short_flags=0 ;; esac
        fi
        ;;
    esac
  done
}

check_merge() {
  local arg
  for arg in "$@"; do
    case "$arg" in --no-verify) block "no --no-verify" ;; esac
  done
}

check_branch() {
  local arg deleting=0 names_main=0
  for arg in "$@"; do
    case "$arg" in
      --delete) deleting=1 ;;
      --*) ;;
      -*d* | -*D*) deleting=1 ;;
      -*) ;;
      *) is_main "$arg" && names_main=1 ;;
    esac
  done
  [ "$deleting" = "1" ] && [ "$names_main" = "1" ] && block "main is not deleted"
  return 0
}

check_reset() {
  local arg hard=0 target=0
  for arg in "$@"; do
    case "$arg" in
      --hard) hard=1 ;;
      origin/main | origin/master) target=1 ;;
    esac
  done
  [ "$hard" = "1" ] && [ "$target" = "1" ] && block "no hard reset to origin/main: start a new branch instead"
  return 0
}

check_output_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in --output | --output=*) block "git diff and git log do not write files here" ;; esac
  done
}

check_segment() {
  local tokens i=0 count dir=""
  read -ra tokens <<<"$1"
  count="${#tokens[@]}"
  [ "$count" -eq 0 ] && return 0
  if [ "${tokens[0]}" = "cd" ]; then
    cd_dir="${tokens[1]:-}"
    return 0
  fi
  # git counts only as the command itself, after a prefix that runs it. Anywhere
  # else, as in grep or in the text of a message, it is just a word.
  while [ "$i" -lt "$count" ]; do
    case "${tokens[$i]}" in
      *=* | env | command | sudo | time | exec | xargs | then | do | else | '{' | '!' | bash | sh | zsh | -c | -lc) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -ge "$count" ] && return 0
  case "${tokens[$i]}" in
    git | */git) ;;
    *) return 0 ;;
  esac
  i=$((i + 1))
  while [ "$i" -lt "$count" ]; do
    case "${tokens[$i]}" in
      -C)
        dir="${tokens[$((i + 1))]:-}"
        i=$((i + 2))
        ;;
      -c | --git-dir | --work-tree | --namespace | --config-env) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -ge "$count" ] && return 0
  local subcommand="${tokens[$i]}"
  local args=("${tokens[@]:$((i + 1))}")
  case "$subcommand" in
    push) check_push "${dir:-${cd_dir:-.}}" "${args[@]}" ;;
    commit) check_commit "${args[@]}" ;;
    merge) check_merge "${args[@]}" ;;
    branch) check_branch "${args[@]}" ;;
    reset) check_reset "${args[@]}" ;;
    diff | log) check_output_flag "${args[@]}" ;;
  esac
}

# One command per line: continued lines joined, no quotes, no redirections, and
# every separator turned into a line break.
continuation=$'\\\n'
command_text="${command_text//"$continuation"/ }"
segments="$(printf '%s' "$command_text" |
  sed -E "s/[\"']//g; s/[0-9]*&?>>?&?[[:space:]]*[^[:space:]&|;()]*//g" |
  tr '&|();' '\n\n\n\n\n')"

while IFS= read -r segment; do
  check_segment "$segment"
done <<<"$segments"
exit 0
