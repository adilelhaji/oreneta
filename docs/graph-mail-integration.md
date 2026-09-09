# Graph read integration (#128)

Additive implementation of accepted ADR-0004, following #125/#127. Desktop
global-service, signed-in mailbox only. No automatic IMAP/EWS conversion.

## Activation and capabilities

- The account wizard offers an explicit **Microsoft Graph — read-only** choice;
  domain discovery never chooses it implicitly. Existing Outlook setup keeps
  IMAP/SMTP. Graph reconnection keeps the selected account and pinned principal.
- After backend authorization, start a cancellable activation job. Read the
  complete visible folder hierarchy and complete the initial Inbox delta round
  before publishing a new `engine=mail`, `auth_type=graph_oauth` account. Report
  progress/errors while waiting; authorization alone is not readiness.
- An existing non-Graph account with the same normalized address is a collision,
  not permission to convert it. Never overwrite its metadata, grants or cache.
  Retrying Graph activation may resume its own durable staged read state.
- Pending Graph profile metadata is separate from active accounts. Cancellation
  or process exit does not publish it; a later explicit attempt can resume.
  Cancellation/removal invalidates the generation before late work can commit.
- Active Graph accounts support cached/offline folder, conversation and body
  reads. Inbox readiness is not a claim that every other folder is synchronized;
  opening/synchronizing a folder completes its own independent delta round.
- Sending, remote drafts, flags/read-state edits, move/copy/delete, attachments,
  calendars, contacts, shared mailboxes and national clouds remain unsupported
  in this slice. Disable their UI affordances and reject their backend commands
  before any mutation, SMTP, IMAP or delegated fallback. Local labels and
  existing local drafts are preserved; reading does not mark remote mail read.
  Local label assignments remain available; remote label linking is blocked.
  This includes keyboard/bulk paths, draft menus, folder creation and kanban
  dragging. Failed wizard cancellation retains its handle for an explicit retry.

## Identity and folder projection

- Graph folder/item IDs remain opaque, case-sensitive, account-qualified values.
  Separate Graph tables map them to existing cache locators. Never parse/hash an
  item ID into a UID or reuse the EWS mapping. Allocate durable local `u32`
  surrogates monotonically per account; never reuse tombstoned mappings.
- Resolve special-use folders through Graph's well-known aliases, not translated
  display names. Inbox uses the existing `INBOX` cache alias; other folders use
  a stable encoded ID locator. Display name and parent relationship are separate
  metadata, so rename/reparent does not alter saved cache/kanban references.
- Traverse root pages and every visible child's pages. Detect cycles, repeated
  links, inconsistent parents and conflicting IDs. Limits bound work per page,
  not the reported mailbox size: do not truncate and call it a complete tree.
  Hidden/system-only folders are not requested in this slice.
- Persist the full successful folder listing atomically. A failed traversal
  leaves the previous listing intact. Only Graph-owned cache memberships may
  be retired when their folder is absent from a complete replacement listing.
- Message identity maps independently of its folder membership. Cross-folder
  moves retain the local surrogate and Graph conversation key. Folder-scoped
  tombstones remove only that membership, not unrelated copies/local labels.
  Physical folders validate returned parent IDs; search-folder views may refer
  to their underlying physical folder.

## Delta durability and cache transactions

- Keep active message data/checkpoint separate from a durable staged round.
  Each accepted page and its validated continuation are journalled atomically.
  A restart/retry resumes staging; it never promotes an incomplete round.
- Staging merges sparse fields with their previous values. Missing fields are
  unknown, not empty/false. For a previously unknown sparse item, fetch its full
  representation before projection. Invalid items/pages fail the whole page.
- Only a final delta checkpoint permits one transaction to update Graph item
  records, memberships, existing message/body cache, sync state and checkpoint.
  Refactor shared envelope upsert to accept a caller-owned transaction while
  retaining its existing public transaction wrapper for IMAP/EWS callers.
- The reader uses existing sanitization/CSP and thread formats. Graph
  conversation IDs use an explicit encoded namespace, not subject heuristics.
  Preserve user-owned JSON/local state when updating remote metadata; explicit
  empty recipient arrays still clear stale remote recipients.
- A 410/expired continuation discards only staging and starts an explicit full
  resync state. Retain visible cache until that full round completes; then prune
  only its missing Graph memberships. No old/new traversal mixing. Throttle and
  authentication errors retain staging and return typed failure/retry delay;
  no immediate blind retries or blocking retry sleeps.
- Serialize per-account Graph work and check cancellation before persistence.
  Bound each network operation; an async caller's timeout cannot authorize a
  detached blocking task to publish a cancelled activation/account.
- Account removal deletes Graph profiles/mappings/staging inside the existing
  account-delete transaction after the #127 credential cleanup succeeds.
  Ordinary IMAP/EWS accounts and grants use their existing paths unchanged.

## Validation gate

Provider/vault/SQLite fixtures: complete and interrupted hierarchy, duplicated
names, rename/reparent, opaque IDs, pages/sparse deltas/tombstones, moves, atomic
rollback, 410 recovery, restart/cancellation, account collision/isolation, local
draft/label preservation, HTML sanitization and unsupported-operation guards.
Production-entry frontend tests cover Graph choice, authorization/activation
progress, error/retry/cancel, read-only account and legacy setup regression.
Logic/business reviews and all seven exact-head CI jobs precede merge commit.
Fixtures do not establish real-tenant or native Windows interoperability;
those and installable exact-SHA artifacts remain separate acceptance evidence.

UI copy: English and Spanish; new Graph strings use English fallback in the
other canonical catalogs. This is not complete localization parity.

Sources checked 2026-09-09: [folders](https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0),
[message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages).
