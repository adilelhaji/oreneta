# ADR 0003: Conversation pagination

Status: Accepted — 2026-09-08. Maintainer approval in the #30 working conversation.

## Decision

Desktop and mobile will share one conversation-page contract in the Rust core.
Group eligible messages into complete candidate cards **before** ordering and
limiting. Existing account/folder-qualified, subject-branch-aware thread IDs
remain the row identity. No persistent projection, schema migration or provider
change is authorized by this decision.

For cache-backed mail, eligibility uses existing message-level facets. The
representative is the latest matching message by `(date, UID)`, independent of
sort direction. Apply outgoing-recipient/display-name normalization before
ordering. Preserve existing canonical-root subject/branch identity rules and
reader scope; paging must not fetch bodies or mark messages read. The adapter
must build aggregates from its complete cached card scope, not the page slice.

Order by representative date, displayed sender (name, otherwise address), or
displayed subject. Text comparison uses ASCII lowercase, preserving whitespace
and non-ASCII code points, matching the existing SQLite lower-case convention.
The qualified card ID breaks ties. Direction applies to both keys. Unified
views use the same comparator and one global limit, not a limit per account.

The new opaque `conv1:` keyset cursor carries a view-context digest and the last
conversation's ordering key/ID. Context includes source namespace, resolved
account/folder scopes, trimmed query, normalized facet set and canonical sort.
Scope/facet enumeration order is irrelevant. Page size may change. Malformed,
legacy or cross-context cursors fail explicitly with a first-page-reload error;
they must never silently become first-page responses appended to old rows.
Raw-message callers keep their existing cursor contract during migration.

This is a live keyset contract, not a mailbox snapshot. Unchanged candidates
traverse exactly once. Insertions after the cursor can appear on later pages;
insertions before it need a first-page refresh. Moving an existing card across
the cursor can omit/repeat it until refresh. Clients deduplicate IDs and replace
the loaded traversal on refresh; they must not graft new rows onto old cursors.
Provider results not yet cached are outside cache-backed completeness claims.

## Delivery and constraints

1. #67: tested shared ordering/cursor primitive; no active route changes.
2. Follow-up: cache-backed candidate acquisition, desktop/mobile adapters,
   unified global paging and client refresh/error handling with integration tests.
3. Reconcile search snapshots, starred cross-folder deduplication, snoozed
   wake-up ordering and RSS separately before enabling this contract there.

Candidate acquisition must not impose an invisible message-count cutoff.
Initial cache-backed integration may scan lightweight metadata in chunks and
retain grouped candidates; enrich only the selected page. Record the resulting
O(cached headers) scan cost and test large-thread traversal. A persistent index
or a different provider/snapshot contract requires a separate architecture
decision. The parent #30 remains in progress until end-to-end acceptance is met.

## Verification

Test all six sorts, empty/repeated/Unicode keys, qualified identity collisions,
page-size changes, invalid and cross-view cursors, full stable traversal and
the stated mutation boundaries. Adapter tests must additionally cover branches,
filtered representatives, identity rewriting, unified membership, full-thread
aggregates and desktop/mobile equivalence. Existing CI remains the delivery gate.
