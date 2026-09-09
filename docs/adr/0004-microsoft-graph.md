# ADR 0004: Incremental Microsoft Graph adapter

Status: Accepted — 2026-09-09. Maintainer approved “sí, incorpóralo” after
the explicit adapter/per-account/minimal-delegated-consent proposal in #46.

## Decision

Add Microsoft Graph v1.0 for supported Exchange Online capabilities inside
the existing Rust core. Keep Wails, the stdio bridge, IMAP/SMTP and on-premises
EWS. Adoption is explicit per account, never inferred from an email domain.
No automatic migration, protocol fallback, public service or app-only access.
Existing OAuth grants remain unchanged; Outlook-resource tokens must never be
reused as Graph grants. Consent and tenant policy are separate requirements.

Request permissions incrementally: `Mail.ReadBasic` for folder/basic metadata
discovery, `Mail.Read` for full reading, `Mail.ReadWrite` for editing (does not
include sending), and separately `Mail.Send`, `Calendars.ReadWrite` or
`Contacts.ReadWrite` when their feature is enabled. Shared-mailbox permissions
and national-cloud endpoints require their own documented capability slices;
the initial implementation targets the global service and signed-in mailbox.

## Contracts (#24 / #25)

- Graph IDs are opaque and case-sensitive, qualified by account and resource
  kind. Send `Prefer: IdType="ImmutableId"` on every item request. A Graph ID
  is not an IMAP UID, EWS ID or local conversation ID. Moves to archive
  mailboxes/export-import can change it. Do not correlate by subject/address.
- Page/delta links are opaque provider checkpoints bound to the originating
  account and collection. Follow only validated HTTPS Graph v1.0 URLs for that
  exact collection. Never forward bearer tokens through redirects. Fetch one
  bounded page at a time; errors are not empty successful snapshots.
- Preserve Graph error categories: reauthentication, access denied, not found,
  conflict, throttled, checkpoint expired, unavailable, invalid response and
  transport failure. Return retry delay without sleeping or blindly retrying.
  Do not expose response bodies, credentials or checkpoint URLs in errors/logs.
- A complete delta round may advance its checkpoint only atomically with the
  corresponding cache changes. Incomplete reads must not delete local data.
  A rejected checkpoint requires explicit resync, not merging a new first page
  into an old traversal. Writes use concurrency tokens where supported;
  uncertain sending is reconciled, never automatically repeated.
- X1 changes no persistent schema, existing account or mail cache. Before
  enabling Graph in the mail session pool, document/test the exact projection,
  rollback, local-draft/label preservation and token-storage migration in its
  implementation slice. This decision permits that additive integration, not
  destructive conversion of an existing profile.

## Delivery

1. #125: native read adapter, explicit in-memory Graph grant, transport and
   checkpoint contracts; fixture/loopback validation. Not a user-activatable
   account backend, no OAuth exchange and no production account switch yet.
2. Per-account OAuth/PKCE consent and separate secure credential lifecycle;
   cancellation, refresh, revocation and explicit activation UI.
3. Mail projection/delta recovery and read integration; then mutations,
   drafts/send reconciliation and attachments with per-operation tests.
4. Calendar/contacts and separately delegated capabilities; each remains an
   explicit gap until implemented and tested. No beta API dependency by default.
5. Controlled provider/native acceptance and installable exact-SHA artifacts.
   No live-mail experiment, tenant reconfiguration or release is authorized here.

## Sources and limits

Verified 2026-09-09: [permissions](https://learn.microsoft.com/en-us/graph/permissions-reference),
[IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id),
[paging](https://learn.microsoft.com/en-us/graph/paging),
[throttling](https://learn.microsoft.com/en-us/graph/throttling),
[folder scope](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0).
Graph availability is not eM Client parity. #46 retains account-exposure and
unsupported-operation discovery; #22 retains product-wide acceptance.
