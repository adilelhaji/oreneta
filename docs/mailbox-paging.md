# Mailbox loading and pagination

## R4.1 (#63)

Rows and cursors belong to one account/folder/query/filter/sort key. Only a
matching view may load another page. Changing any field rejects old responses
even before the React reload effect runs. A first-page refresh invalidates
in-flight pagination; a background load cannot merge rows from another view.

Every `mail.threadList` request repeats the existing `sort` parameter. A sort
change reloads the first page through the normal mailbox effect (search keeps
its existing debounce). Cache-to-live search also checks sort before advancing.
The empty/loading UI uses the same full key as the loader. Later single-account
pages keep backend order and deduplicate by thread identity, including duplicate
identities within one response.

The cursor encoding, database and supported sort capabilities do not change.
These are transport/state guarantees, not end-to-end sorting certification.

Validation: 21 of the initial 25 state regressions failed on `cde6e1f` before
the fix. The final suite adds 29 state and 5 rendered React tests, covering
header clicks, all six sort parameters, stale requests, retry, debounce,
unmount, board deferral and empty/loading state. On Windows/Bun 1.4.2 the full
frontend suite passed 831 tests; typecheck and the 24 Chromium baseline cases
passed. CI reruns the suite for the delivery commit; browser mocks do not
certify provider ordering.

## R4.2 (#65)

New text cursors carry the exact SQL ordering key, preserving whitespace and
database case-folding semantics; see [text-key pagination](text-page-cursors.md).
Cursor encoding and supported sort capabilities remain unchanged.

## R4.3 (#67): shared cursor primitive

[ADR 0003](adr/0003-conversation-pagination.md) records the approved replacement
contract. #67 introduces its shared ordering/cursor primitive only; existing
routes still use the R4.1/R4.2 behavior until their adapters are migrated.

## R4.4 (#69): cache adapter preparation

The shared cache service reads lightweight folder headers in 1,024-message
chunks through the existing message keyset query, without a total-row cutoff.
It groups the complete cached folder, retains cards with a matching message,
and uses the latest matching `(date, UID)` for displayed sender/date. Canonical
root subjects and branch IDs come from the complete folder, not filtered hits.
Unread/starred aggregates cover the cached folder card; message counts retain
the existing reader-scope, cross-folder deduplication. Snoozed card/root keys
are excluded before pagination. No bodies are fetched and no seen flags change.

One SQLite read transaction covers candidate acquisition, paging and enrichment.
The caller supplies resolved mail scopes and source namespace; scopes are
canonicalized/deduplicated and all eligible cards share one global limit.
Search, starred-only, snoozed and RSS are not inputs to this Recent-only service.
Only selected cards receive metadata enrichment, grouped by account/folder.

Cost: each response scans the cached header set (and a second filtered set for
faceted views), retains O(headers + cards) metadata, and sorts O(cards log cards).
Existing display-name resolution queries still apply. This favors correctness
without a persistent projection; it is not a constant-time large-mailbox claim.
Routes and clients are not activated by #69; the follow-up must handle refresh
replacement, cursor errors, stale responses and backend-order preservation.

## Remaining #30 work

R4.5 (#71) prepares mobile: thread-list errors propagate instead of becoming
empty pages; requests explicitly carry the default date sort (the shared command
also accepts other sorts, without adding a UI control). Appends preserve core
order and deduplicate IDs. A captured view/generation/cursor rejects stale
pagination after navigation or refresh. The explicit conversation-cursor reload
error triggers a no-cursor replacement load for the same current view; ordinary
failures retain the cursor for retry. Existing depth-aware refresh replacement
is retained. This does not activate the new core routes.

- Unified server fan-out and merge still impose date ordering.
- Search and starred use date-based contracts; snoozed uses wake-up order and
  RSS has its own listing. Generic table headers do not establish support.
- Retained selection, same-view background merges, incremental insertions and
  grouped-card keys still require ordering validation.

Do not close #30 until those contracts and stable-dataset traversal are tested.
New arrivals can change a live mailbox; this slice does not introduce a snapshot
or guarantee a globally complete order over messages not yet fetched.
