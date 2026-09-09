# Microsoft Graph delivery

Approved direction: [ADR-0004](adr/0004-microsoft-graph.md), #46.
First implementation: #125 in `meron-core/src/graph` (shared native library).

## Availability

X1 is a callable Rust read adapter, **not yet an account option in the app**.
It does not exchange/refresh/store credentials, replace `backend::Session`,
modify IMAP/SMTP/EWS accounts, update the cache or send mail. No executable or
installer is replaced by these changes. Real-provider acceptance remains open.

| Capability | X1 | Required delegated scope |
|---|---|---|
| Root folders / immediate children | Typed, paginated reads | `Mail.ReadBasic` |
| Folder messages / single message | Typed reads, no mark-read side effect | `Mail.Read` |
| Folder message delta | Sparse changes/tombstones and scoped checkpoints | `Mail.Read` |
| Edit/move/delete/drafts | Not implemented | Later `Mail.ReadWrite` |
| Send and uncertain-send recovery | Not implemented | Later `Mail.Send` |
| Calendar/contact synchronization | Not implemented | Later per-feature consent |
| Shared mailboxes / national clouds | Not enabled by X1 | Separate capability slice |
| Generic public-folder / group-mailbox CRUD | Known Graph parity gaps | Not solved by consent |

`Grant` must receive a Graph token, **provider-returned** scopes, expiry and
verified account binding from the later OAuth integration. Its public Rust
constructor is not a token validator: the OAuth host must validate issuer,
account and audience before constructing it. No grant/token/checkpoint is
serialized or exposed over the frontend bridge. No debug output for grants;
checkpoint debug output omits the URL. Scope checks are case-sensitive and do
not equate Outlook-resource scopes, app-only or shared scopes with `/me` access.

## Read and recovery contract

- Blocking HTTP through the resolved per-account proxy; async callers must
  use `spawn_blocking`. Fixed global Graph v1.0 endpoint; 30-second request cap,
  4 MiB response cap, at most 1,000 returned items per page. Oversized or
  malformed results fail, never silently truncate. `$top` / max-page preference
  requests 100; consumers continue using the supplied checkpoint.
- One page per call; root folders are **not** the entire hierarchy. Consumers
  explicitly traverse child folders and must bound/cancel their own traversal.
  HTTP errors do not trigger retries or sleeps. Retry-After is returned intact
  (seconds or HTTP date); absent delay remains unknown, not zero.
- IDs include account and kind and retain case. Item requests include immutable
  ID preference. Do not cast them to local UIDs or infer identity from subject.
- Checkpoints are in-memory, opaque and bound to exact account/collection.
  Foreign origins, protocol changes, userinfo, fragments, mailbox/collection
  changes and redirects are rejected. Documented equivalent `/mailFolders/id`
  and `/mailfolders('id')` spellings are accepted without changing ID case or
  the provider's query values. `percent-encoding` was already resolved by `url`;
  declaring it directly adds no new resolved package.
- A next-page checkpoint means the round is incomplete; a delta checkpoint
  finishes it. X1 never commits a checkpoint or deletes data. Consumers must
  detect repeated traversal cycles and atomically persist applied changes with
  the completed checkpoint in the later projection slice. A tombstone is a
  provider change, not a command to delete unrelated/local-only data.
- Sparse message fields retain `None` instead of fabricating false/empty values.
  Raw HTML must pass through the existing sanitizer before rendering.
- Errors expose only locally defined categories/status/delay, never provider
  bodies, bearer tokens or checkpoint URLs. 401 requires reauthentication;
  403 is policy/access denied (not necessarily missing consent); 410 requires
  resync; 429 is throttled; 5xx is unavailable. Other unexpected statuses and
  malformed pages fail closed. Existing mail paths are unchanged.

## Next implementation slices

1. #127: OAuth/PKCE and explicit per-account authorization; distinct secure Graph grant,
   returned-scope verification, cancellation and refresh/revocation tests.
2. #128: account-qualified Graph-to-cache projection, delta commit/recovery, local
   draft/label preservation and explicit activation/UI/session integration (#24/#25).
3. Writes, attachments, conditional updates and reconciled send lifecycle.
4. Calendar/contacts and delegated capabilities; provider/native acceptance.

X1 fixture/loopback tests run under the existing Rust CI job, offline from
Microsoft. They test protocol behavior, not authorization of a real tenant or
Windows/WebView2 rendering. #46 and the parity program remain open.
The loopback fixture explicitly switches accepted sockets to blocking mode
(Windows inherits the listener mode), and its proxy case completes CONNECT
before reading the tunneled GET. Transport failure uses an owned connection,
not a released ephemeral port. Local command:
`cargo test --locked --manifest-path meron-core/Cargo.toml --lib graph::`.

Sources verified 2026-09-09:
[folder API](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0),
[delta](https://learn.microsoft.com/en-us/graph/delta-query-messages),
[Graph gaps / EWS Online timeline](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online).
