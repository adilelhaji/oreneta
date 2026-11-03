---
name: review-branch
description: Reviews the current Oreneta branch against origin/main before a push, with the project reviewers and the checks, and ranks the findings. Usage: /review-branch [issue number].
argument-hint: [issue number]
---
Review the current branch for issue `$ARGUMENTS` (if none is given, take it from the branch name `issue-<number>-...`) as someone who did not write it.

1. **Gather**: the acceptance criteria of the issue, `git diff origin/main...HEAD`, and the output of `scripts/comprobar.sh` (run it if you do not have it).
2. **Launch together and wait for all of them**. They do not see this conversation, and do not tell them what you think is fine.
   - `code-reviewer`, with the issue, the diff and the check output. Also ask it for a table with one row per acceptance criterion: met or not, and the test that shows it.
   - `catalan-reviewer`, only if the diff touches `docs/adr/`, `docs/design/` or `locales/ca.json`.
3. **Consolidate**: remove duplicates and rank as **blocks**, **should fix** or **optional**. These always block: an acceptance criterion without a test, a broken rule from `CLAUDE.md`, and a description that does not match the diff.
4. **Act**: fix what blocks, run the checks again and send the new diff to the same reviewers. Fix what should be fixed if it fits this issue; otherwise propose another issue.
5. **Three rounds at most.** If something still blocks after that, stop and ask the owner, with two or three options.
6. **Return**: the criteria table, what was fixed, what was left and why, and the final check output. It goes into the pull request.
