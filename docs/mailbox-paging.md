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

## Remaining #30 work

- Unified server fan-out and merge still impose date ordering.
- Search and starred use date-based contracts; snoozed uses wake-up order and
  RSS has its own listing. Generic table headers do not establish support.
- Retained selection, same-view background merges, incremental insertions and
  grouped-card keys still require ordering validation.
- SQL text collation and cursor text normalization require parity checks for
  whitespace/non-ASCII sender and subject values.

Do not close #30 until those contracts and stable-dataset traversal are tested.
New arrivals can change a live mailbox; this slice does not introduce a snapshot
or guarantee a globally complete order over messages not yet fetched.
