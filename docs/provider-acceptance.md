# Repeatable mail acceptance (#145, slice #184)

The [matrix](provider-acceptance-matrix.json) maps every current subtest of
`TestIntegrationMailFlow` to 12 user outcomes. This is an executable **isolated
IMAP/SMTP** pack, not a certification of Gmail, Workspace, Graph or the Windows
UI. The [parity ledger](emclient-parity-acceptance.md) retains its independent
native/provider requirements. #145 remains open for live evidence and remaining
fixtures/procedures; #184 delivers this reporting slice.

## Automatic execution and evidence

The existing `integration` job starts maddy 0.8 with loopback-only ports and two
synthetic accounts (`alice@maddy.test`, `bob@maddy.test`). Its submission server
delivers only to its local mailboxes; it has no remote SMTP delivery route.
Profiles, database and keyring settings use the existing temporary test fixture.
Container and profile cleanup are registered by the harness. No real accounts,
credentials or user mail are required. Fixtures use runtime correlation IDs;
attachment/MIME assertions live in `integration_test.go`.

CI runs the suite afresh with `-json -count=1`. The reporter reads that execution's
events and writes `integration-results/report.json`; only this sanitized file
is uploaded as `isolated-mail-acceptance-<sha>-attempt-<n>`, preserving separate
rerun artifacts. Free-form logs, payloads, account
addresses, container logs and unknown test names are not copied into the report.
Raw events remain on the runner for this job, not in the artifact. The separate
three-run IDLE check remains mandatory; its result is in the CI job, not in the
12-outcome report. A passing report alone cannot establish that the whole job
or all seven required suites passed.

The report records exact source SHA, workflow URL and attempt, test-level status and
explicit `not-tested` live/native boundaries. PR reports refer to the tested
merge ref; delivery requires fresh main CI for the actual merge commit. Never
relabel evidence from another commit. The report records provenance supplied
by CI; it is not a cryptographic attestation of test execution.

Missing Docker can skip the underlying integration test locally, but cannot
produce a passing acceptance report. Missing, skipped, failed, incomplete,
replayed or malformed mandatory evidence fails the reporter; suite/package
failures and other failing tests also block success. Reports are generated on
failure, including missing input after an earlier build failure. The matrix
coverage test rejects unclassified or renamed mail subtests.

Run the isolated suite locally on Linux with the existing build dependencies:

```sh
cargo build --manifest-path meron-core/Cargo.toml
mkdir -p integration-results
MERON_KEYRING=off go test -tags 'integration webkit2_41' -json -count=1 -timeout 10m . > integration-results/events.jsonl
```

The reporter's CI invocation is in `.github/workflows/test.yml` and receives the
actual run URL and tested SHA from GitHub. Local runs are not CI evidence; do not
bind local results to an unrelated workflow URL. Reporter/negative-case tests
require no server: `node --test scripts/ci/provider-acceptance.test.cjs`.

## Dedicated live-account procedure (not executed)

Before any external run, obtain authorization naming the provider, dedicated
accounts, operations and exact test-recipient allowlist. No production mailbox
or inherited upstream Google OAuth application may be used. Keep tokens outside
the repository/artifacts; record scope names, never token values. Provisioning,
tenant changes and external sending are separate actions, not implied by CI.

Record per operation: candidate SHA and executable hash; app/core and OS
versions; provider/tenant kind; auth mode and granted scopes; isolated profile;
initial folder/cache state; synthetic run/message IDs and attachment SHA256;
expected result; observed result; timestamps and redacted evidence reference;
cleanup outcome. Identify accounts by test aliases in retained evidence.

Use a dedicated folder containing synthetic plain text, Unicode/quoted-printable,
HTML alternatives, inline images and a known attachment. Create enough messages
to cross a provider page boundary and record that count. Repeat matching subjects
across two accounts to expose scoping mistakes. Do not reuse real mail as fixtures.

| Operation | Procedure and expected observation | Cleanup / failure boundary |
| --- | --- | --- |
| Read and paging | Read each fixture and cross the page boundary; compare counts, IDs, body and attachment hashes against server state | Remove only the run's fixtures; distinguish uncached from absent |
| Send | Send one correlated message from test A to allowlisted test B; record submission result, independent receipt at B and server Sent copy as three separate observations | Do not blindly resend an uncertain outcome; preserve its correlation and inspect server state first |
| Flags/moves | Change one fixture and observe it from an independent client; verify same-subject mail in the other account is untouched | Restore original folder/flags for the run's message IDs only |
| Drafts/files | Save, restart and reopen; compare recipients, body and file hashes; exercise interrupted save | Keep uncertain draft state until reconciled; do not infer full-profile backup from remote-draft success |
| Offline/reconnect | Disconnect only the test environment; read cached mail and observe honest failure for uncached data; reconnect and compare changes | Restore connectivity; check duplicates and unsent/uncertain messages before further actions |
| Revocation | Revoke only the dedicated test grant, observe account error and reauthorize the same principal | Requires explicit grant-revocation authorization; preserve unrelated accounts |
| Rate limit | Use a provider-approved test mechanism if available; record Retry-After and absence of retry storms | Never flood a live service to manufacture throttling; otherwise leave this row untested and reference fixture coverage |

### Provider boundaries

- **Generic IMAP/SMTP:** maddy proves the isolated protocol/store route, without
  production TLS, OAuth or a particular host's quirks. Live rows require these
  independent checks; protocol support is not universal provider acceptance.
- **Gmail consumer and Google Workspace:** separate executions; record OAuth or
  app-password mode and applicable policy. Reconcile Gmail labels with IMAP
  folders, Sent and Trash in the authorized account. Consumer results cannot
  certify Workspace tenant restrictions. Do not use Meron's bundled OAuth client.
- **Microsoft 365 Graph:** current [contract](graph-mail-integration.md) is
  delegated read-only for the signed-in mailbox. Record granted scopes and
  pinned principal, activate Inbox, open other folders, page, read cached bodies,
  reconnect and check invalidation. Existing Rust fixtures cover rate-limit,
  scope, continuation, cancellation and cache rollback; they are not live runs.
  Sending, remote drafts, flags/moves/deletion, attachments, calendars, contacts
  and shared mailboxes remain **unsupported**, not failed or passed tests.

Graph writes wait for their owning implementation issues. Gmail/Workspace/Graph
live rows remain `not-tested` until authorized independent evidence exists.
Native installation remains blocked locally by Application Control pending the
separate signing process. Windows startup/zoom CI evidence does not certify mail
workflows, full profile recovery or installation on the user's machine.
