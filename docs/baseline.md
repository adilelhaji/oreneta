# Functional and visual baseline

## Scope

Reference code: `fe72de7c777718b2649969d18d40be84b96bfd0c` (2026-09-08).
PRs #11, #18, #20 and #58 are integrated. [Main CI](https://github.com/adilelhaji/oreneta/actions/runs/34221227862)
passed Go, Rust, frontend, mobile, Maddy integration and workflow policy.
That run predates the browser fixture; new browser results belong to #59's own
PR/main CI and must not be attributed to this historical reference run.

This is an internal engineering baseline, not pilot entry or provider approval.
ADR-0001 (native Wails/Rust/Go/React) and ADR-0002 (explicit remote-label links)
remain unchanged. #22 owns pilot participants, provider/platform matrix and exit
criteria; #23 owns complete baseline acceptance.

## Visual evidence contract

The isolated `frontend/baseline` test entry reuses production components, styles
and built-in themes. It does not boot the app or access a real backend. Synthetic
addresses use `example.test`; data, clock, locale, timezone and viewport are fixed.
Mock commands are explicitly allowed; unknown commands are rejected. There is no
mock fallback in the production bridge or application entry.
The fixture has placeholder account fields but no credentials or secrets. App
boot is absent and the in-memory transport cannot connect, independently of the
account's `paused` flag. This is state-seeded component evidence, not proof of
backend interaction or successful mail delivery.

CI captures light/dark inbox, reader, composer and tasks at 1440/1024/600 pixels.
Artifacts identify the actual tested SHA and fixture checksum. Chromium captures
are component evidence, not a native-webview end-to-end test. Existing Indigo
defaults are captured as-is: the approved cobalt/navy direction is the subsequent
comparison target in #32/#33, not silently applied by this baseline.
Remote font imports are removed in the test-only build. Platform fallback fonts
can change glyph metrics: screenshots are not pixel-comparable across different
OS/font installations. Native WebKitGTK/WKWebView/WebView2 rendering, IME and
Wails window integration are not validated by this Chromium harness.

Local validation host: Windows. Go/WebKitGTK, Rust, Docker/Maddy and mobile
toolchains are unavailable locally; their CI results are recorded separately.
The initial frontend run on the Spanish Windows host had 770 passing tests and
four English-only date expectation failures, tracked in #60. Production locale
behavior is not changed to make those tests pass.
The #60 correction asserts native locale output and exact formatting options,
including same-day and cross-year branches. Its affected suite passed 41 tests
on that Spanish host; full-suite and CI results belong to #60's delivery commit.

## Reproduction in CI

The `frontend` job installs the root and frontend lockfiles, generates and
validates catalogs, runs catalog tests, typecheck and Bun tests, then installs
Playwright's pinned Chromium and runs `bun run baseline:verify`. The test runner
owns its loopback-only Vite server; it is not a deployment script. The fixture
runner is Playwright 1.63.0 with Bun 1.4.2 and Node 22 in CI.

Each of 24 captures produces a PNG and JSON provenance (checkout SHA, workflow
SHA, fixture checksum, browser/runtime and display settings). CI uploads the
`baseline-<workflow SHA>` artifact with the HTML report and failure traces. PR
checkout SHAs may be GitHub's synthetic merge commit; provenance records both
values rather than mislabelling branch-head tests as post-merge evidence.

Known visual defect (#34): at exactly 600 px, current strict `<600px` responsive
rules leave the selected reader outside the viewport. Both 600px reader captures
record this defect in `knownLimitations` and assert the offscreen state explicitly;
they are not successful visible-reader evidence. The other reader widths must
intersect the viewport. Fixing the breakpoint requires updating this deliberate
characterization alongside the production fix, not weakening the assertion.

## Capability ledger

| Capability | Implementation / automated evidence | Availability and limits |
|---|---|---|
| IMAP/SMTP mail and complex MIME | Rust/Go tests; synthetic Maddy integration; vendored IMAP parser tests (#19) | Implemented; no real-provider delivery certification |
| Gmail labels | #20, store/translation tests | Explicit links; live Gmail/OAuth interoperability unverified |
| Exchange/delegation/calendar | EWS backend, parser tests and probe examples | Tenant/platform support unverified; #46/#48 own continuity/delegation validation |
| Contacts | CardDAV/Google/Exchange code and parsing tests | Incomplete-sync risk remains under #28 |
| Local message-linked tasks | #18, Rust/Go/React tests | Local only; #42 owns recovery validation |
| PGP/S/MIME and identity backup | #11, crypto and backup tests | External interoperability/trust remains #9/#12/#49; not certified by mocks |
| Spam suggestions | #18, Rust/React tests | Suggestion-only; explainability/repeat safety remains #50 |
| Design system | Current components/themes; synthetic browser captures | Approved art direction remains partly unimplemented; no accessibility certification |
| Releases | #58 exact-SHA gate and 41 tests | Branch/tag administration and remaining gates under #26; no release launched |

## Reliability findings

| Finding | Owner | Baseline status |
|---|---|---|
| H01: Sweep reviewed-set scope | #27 | Hypothesis; executable reproduction still required |
| H02: incomplete CardDAV replacement | #28 | Hypothesis; executable reproduction still required |
| H03: uncertain send/retry and Sent archival | #29 | Hypothesis; executable reproduction still required |
| H04: sort/pagination and stale-row identity | #30 | #63 covers frontend propagation/stale views; #65 covers SQL/cursor key parity; remaining scope in [mailbox paging](mailbox-paging.md) |
| H05: cross-provider search semantics | #31 | Hypothesis; executable reproduction still required |
| H06 | #23 | Definition absent from inspected repository/issue bodies; not invented or reproduced |

These are tracked risks, not claims of observed production incidents. #23 stays
open until its remaining reproductions and evidence are complete.
