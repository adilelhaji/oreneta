---
name: work-issue
description: "Takes one GitHub issue of Oreneta from start to pull request, using the project subagents. Usage: /work-issue 281."
disable-model-invocation: true
argument-hint: <issue number>
---
Work on issue `$ARGUMENTS`. `CLAUDE.md` holds the rules and the subagent table; this is the order to apply them in.

1. **Read the issue**: goal, acceptance criteria and dependencies. If an issue it depends on is still open, stop and say so.
2. **Sync**: `git fetch origin`, then a new branch `issue-<number>-<slug>` from `origin/main`. If it already exists on `origin`, continue on it, and bring `main` in with a merge, never a rebase.
3. **Explore first**: use `Explore` to find the code involved, the neighbouring pattern, the existing tests and any helper that already exists.
4. **Check for what is not ours to decide**:
   - An architecture change needs an accepted ADR first. Shell work follows ADR-0068, ADR-0069 and ADR-0070, in the order of ADR-0068 §9.
   - An owner decision gets a `## DECISION REQUIRED` comment on the issue, with options and a recommendation. Stop that part and carry on with what does not depend on it.
5. **Implement**: pick the subagent from the table in `CLAUDE.md` and pass it the issue number, the files and the acceptance criteria, since it does not see this conversation. Write a test for each acceptance criterion first and confirm that it fails.
6. **Check**: run `scripts/comprobar.sh`. Exit code 3 means some checks could not run on this machine: say which ones and leave them to CI.
7. **Review**: run `/review-branch` and fix what blocks.
8. **Open the pull request**: run `/open-pr`.

Never skip, disable or weaken a test to get to green. If a check fails without this change too, say so and leave it out of this branch.
