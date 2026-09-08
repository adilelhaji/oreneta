# Release quality gate

Desktop and Android release workflows depend on `verify-release.yml` before
building or reading signing secrets. The gate is read-only and requires the
latest `test.yml` **push to main** run for the exact release commit to complete
successfully. All seven suites (`go`, `go-windows`, `rust`, `frontend`, `mobile`, `integration`,
and `workflow-policy`) must be present and successful; skipped, missing,
cancelled, failed, and pending jobs block the release. A green PR run or a green
run on another commit is not sufficient. API/permission errors also fail closed.

Existing release tags must resolve to that same commit (annotated tags are
dereferenced). Desktop tags must match `wails.json`'s product version. A manual
desktop run may create a missing version tag; publication uses the validated SHA
as `target_commitish`, never the moving default-branch tip. Manual Android builds
without a tag remain artifact-only and still require CI on the selected SHA.

## Operator procedure

1. Merge the release changes and wait for all suites in `test.yml` on `main`.
2. Select that exact commit for a matching release tag or a manual release run.
3. Check the **Release commit verified** summary for its SHA and CI-run link.
4. If the gate fails because CI is still running, wait for that CI run and rerun
   the release workflow. Do not bypass the gate or use a different green SHA.

No release is triggered by adding this policy or running its tests. Unit tests
use mocked GitHub responses and run without credentials or signing secrets:

```sh
node --test scripts/ci/*.test.cjs
```

## Scope and remaining work

This implements #57, one part of #26. It is a workflow safety check, **not** a
substitute for protected branches/tags: someone authorized to change workflows
can change this policy. The GitHub integration returned HTTP 403 for branch
protection administration during implementation. An administrator must configure
required checks and protect release tags separately. Broader formatting/static
analysis, changed-path coverage, and toolchain provenance remain under #26.

The policy applies to commits containing these workflows. Historical tags whose
commits predate the gate do not acquire the new workflow retroactively. Do not
dispatch releases from those historical revisions.

API references: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)
and [github-script](https://github.com/actions/github-script).
