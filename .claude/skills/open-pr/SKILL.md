---
name: open-pr
description: "Opens the pull request of the current Oreneta branch with the repository template and the evidence from the checks. Use only when a reviewed issue is finished. Usage: /open-pr [issue number]."
argument-hint: [issue number]
---
Open the pull request of the current branch for issue `$ARGUMENTS` (if none is given, take it from the branch name `issue-<number>-...`).

Check these first, and do not continue if one fails:

1. `git fetch origin`, and the branch is up to date with `origin/main`. If it is not, merge `main` in, never rebase, and run the checks again.
2. `scripts/comprobar.sh` shows no failure caused by this branch. Keep the command and its summary as evidence, including anything it reports as NOT RUN, and say if a check also fails without this branch.
3. `/review-branch` has run on the final diff and nothing blocks.
4. If the change touches the screen, there is a screenshot of the final state.
5. The description you are about to write matches the diff.

Then:

6. `git push -u origin <branch>`.
7. Open the pull request ready for review, following `.github/pull_request_template.md`. Write `Closes #N` only if every acceptance criterion is met; otherwise write `Refs #N`.
8. Do not enable auto-merge and do not merge, unless the owner asks for it.
9. Return the link and say in one line what it is waiting for.

If `gh` has no session, do not sign in: push the branch and return the link to create the pull request by hand, with the body ready to paste.
