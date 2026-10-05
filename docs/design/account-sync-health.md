# Account synchronization visibility (#165 / #150)

## Observed contracts

- `mail.syncError` identifies an account and a diagnostic message, but no
  structured folder or operation identifier. Several concurrent accounts can
  fail. The previous frontend retained only the latest account and erased its
  error on dismissal or any matching-account success.
- `mail.synced` can mean a folder list or one folder refreshed;
  `mail.newMessages` means new-message activity. Neither proves that every folder,
  calendar, contact or background operation is current. Calendar events remain
  independent. RSS errors use the generic error channel and cannot safely be
  attributed here.
- The desktop `mail.sync` bridge defaults to the inbox and returns `online: false`
  when the sidecar is unavailable or its request failed, even with `ok: true`.
  `online: true` only confirms that the sidecar accepted a request: its
  `messages.sync` handler can return `queued: true` before work completes, and
  paused or already-running work can be skipped. It proves neither connectivity
  nor completion and cannot resolve a previous failure with unknown folder scope.
- Account `needs_reconnect` is the explicit authentication signal. There is no
  complete background-sync start/end stream or durable last-complete-sync time.

## Bounded delivery

Retain a session-only record per account, plus a separate unattributed record.
Dismissal hides the prominent notice, not the record. A compact account-sync
control keeps the details reachable. Independent accounts never overwrite one
another. Removed accounts are pruned; a late retry completion cannot recreate
their record or overwrite a newer failure.

Show existing evidence: authentication required, paused account, request pending,
request accepted (not synchronization complete),
unresolved failure, partial mail activity, or unknown. Label any timestamp as
mail activity observed during this session, never as complete mailbox freshness.
Do not invent an expiry/staleness threshold, infer offline status from arbitrary
error text, or turn an unconfirmed response into a success announcement.

Recovery uses the existing `mail.sync` for that exact account and existing account
settings for reconnection. It never invokes sending, a send queue or a Graph write.
Paused accounts expose settings instead of a retry that would do no work. A
record without an account has no retry; it cannot infer the selected account.
Raw diagnostics, tokens and server error details are not rendered in this surface.
The details use wrapping text, normal keyboard controls and a polite status
announcement without moving focus in response to events.

This extends the existing observable UI state; no new persistence, sync engine,
backend event format or recovery architecture is introduced. Unknown error scope
means a later partial success retains a degraded/unverified state. Restarting the
app loses these observations; it does not certify health. Complete service coverage,
native announcements and provider recovery remain acceptance work under #150.

## Verification boundary

Automated coverage exercises simultaneous errors, dismissal, partial/unattributed
activity, unknown/removed accounts, paused/authentication-required accounts, queued
requests, false/missing/rejected confirmations, duplicate requests, newer failures
and late responses. Component tests cover focus, exact account settings and raw
diagnostic omission. Production-entry cases cover Spanish, light/dark, 600/1440px,
keyboard, 200% zoom, session reset and no send invocation. Lightweight technical
and product reviews are resolved; exact-commit CI is the merge gate.

The initial slice changes the account recovery panel and its event observations.
Calendar error presentation retains its existing contract and is not certified by
this panel's acceptance. No native executable, installer,
provider session or production release is changed here.

## Manual refresh follow-through (#167)

Mailbox menus, quick settings, keyboard shortcuts and the command palette share
`syncMail`. That action previously ignored `online`, swallowed unified-account
failures and announced completion immediately. It now uses the same account request
helper as the recovery panel. Unified refresh targets only included accounts;
paused or authentication-required accounts are skipped. Graph remains read-only.
Repeated manual refreshes do not duplicate an in-flight request.

Feedback reports accepted, unconfirmed, already pending and skipped requests,
including mixed outcomes. Acceptance is never synchronization completion and never
clears a known failure. Raw errors are not displayed or logged by this action.
The scoped list refresh is retained after an accepted request: `mail.sync` defaults
to Inbox, while the list request refreshes the selected folder, unified role or live
search. Existing background events update the rows when later data arrives. Neither
request implies complete freshness. List-load diagnostics omit raw server errors.
Informational feedback uses a neutral icon, including accepted/pending/skipped
requests, and long notices wrap within the viewport without shrinking their icon.
A response for
a view the user has left cannot display a completion toast in the new view.
The pending indicator describes sending the request, not background synchronization.
