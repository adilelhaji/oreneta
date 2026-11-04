# Oreneta

Desktop mail and calendar client with native Exchange (EWS), forked from Meron.
Three codebases ship together:

- `meron-core/`: Rust engine (IMAP/SMTP/EWS/Graph, MIME, store, crypto, calendar), built as the `oreneta-core` sidecar
- repository root `*.go`: Wails desktop app (Go module `meron`)
- `frontend/`: React 19 + TypeScript UI (Bun, Vite, Tailwind, Legend State)
- `mobile/`: Kotlin shared/ui modules and iOS

## Commands

Run the checks for every area you touched before you commit. CI runs all of them (`.github/workflows/test.yml`).

```sh
bun run test:go                       # go test ./...
bun run test:rust                     # cargo test --manifest-path meron-core/Cargo.toml
bun run test:i18n                     # catalog tests
cd frontend && bun run typecheck && bun test
cd frontend && bun run format:check   # prettier
bun run i18n:validate && bun run i18n:generate   # after any change under locales/
cd frontend && bun run startup:verify # Playwright production entry + axe audits
cd frontend && bun run baseline:verify
bun run test:integration              # needs Docker (maddy, radicale)
```

The pre-commit hook in `.githooks/` formats staged Go, Rust, TS and Kotlin files. Run `git config core.hooksPath .githooks` once per clone.

## Rules that CI or the owner enforce

- **No physical left/right in the frontend.** Use logical properties (`ps-`, `me-`, `start-`, `inset-inline-*`). `frontend/src/lib/physicalDirection.test.ts` fails on physical ones (RTL, ADR-0061).
- **Every user-visible string goes through `locales/`.** Catalan is the default language (ADR-0062). Add the key to every catalog and use ICU plurals for counts.
- **Themes must pass WCAG AA.** `frontend/src/lib/themes.test.ts` checks all 16 built-in themes. Never hardcode colours; use the `--me-*` tokens (`docs/design/design-system.md`).
- **Architecture changes need an accepted ADR first** (`docs/adr/`, written in Catalan, status line at the top). Shell work follows ADR-0068, ADR-0069 and ADR-0070, in the order of ADR-0068 §9.
- **Owner decisions are not ours to make.** When a change needs one, post a `## DECISION REQUIRED` comment on the issue with options and a recommendation, and stop that part of the work.
- **Parity ledger** (`docs/emclient-parity-acceptance.md`, `.json`): add dated evidence notes, and never raise a row's status without real evidence.
- **Google OAuth.** The compiled-in client credentials belong to Meron. Never ship or document them as ours (see README).

## Git and PRs

- Branches are named `issue-<number>-<slug>`. Reference the issue at the end of commit subjects, as in `... (#281)`.
- Bring `main` in with a merge, never a rebase, on shared branches.
- PRs say `Closes #N` only when every acceptance criterion of the issue is met. Otherwise they say `Refs #N`.
- Docs under `docs/adr/` and `docs/design/` are in Catalan. Code, comments, commits and issues are in English.

## Subagents: which one for which task

Project subagents live in `.claude/agents/`. Delegate by task type:

| Task | Subagent | Model / effort |
|---|---|---|
| Finding where something lives, reading across many files | `Explore` | haiku / low |
| Shell redesign pieces (folder pane, top band, module switcher, right sidebar) or any change spanning several modules or both Go and Rust | `shell-implementer` | opus / xhigh |
| Repeating an established pattern in one more module, or a bounded issue in one area | `pattern-implementer` | sonnet / medium |
| Reviewing a diff before pushing | `code-reviewer` | opus / high, read-only |
| A failing CI check or local test | `ci-fixer` | sonnet / high |
| Catalan prose in `docs/adr/`, `docs/design/` and `locales/ca.json` | `catalan-reviewer` | sonnet / medium, read-only |

- Before every push, run `code-reviewer` on the diff, and `catalan-reviewer` too when Catalan text changed.
- Subagents do not see this conversation. Pass them the issue number, the files involved and the acceptance criteria.
- Escalate to `fable` (`/model claude-fable-5-1`) only when Opus has failed on a task twice.

## Workflow helpers

- `/work-issue N`, `/review-branch` and `/open-pr` (`.claude/skills/`) apply the rules above in order.
- **Owner approval** (decided by Adil on 2026-11-03, confirmed on 2026-11-04). Adil only approves a pull request that changes the architecture or deviates from the original proposal; then stop and ask. The session merges everything else (squash) once `/review-branch` leaves no blockers and every check on GitHub has finished green. `CODEOWNERS` paths are a notice, not a block: say so in the pull request body and do not wait. Accepted ADRs and `## DECISION REQUIRED` still apply, because those are architecture and deviations.
- `scripts/comprobar.sh` runs the local checks from CI, `--quick` only the changed areas, `--full` also Playwright and Docker. Exit code 3 means nothing failed but some checks could not run here.
- `.claude/settings.json` and `.claude/hooks/` block pushes to main, force pushes, and writing secrets or generated catalogs, and run `--quick` when a turn ends. `.claude/rules/` holds reminders that load per folder.
- `.gitignore` ignores `.claude/*` except `agents/`, so a new file in those folders needs `git add -f`.
