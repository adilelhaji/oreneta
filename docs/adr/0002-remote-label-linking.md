# ADR-0002: Remote label linking — local label, optional per-account link, two-way

- **Status:** Accepted
- **Date:** 2026-09-07
- **Deciders:** Adil El Haji (maintainer)
- **Related:** [ADR-0001](0001-web-engine-and-extensions.md)

## Context

Oreneta's labels are, today, local and per-conversation by design. The
label store's own comment says so directly
([`frontend/src/states/labels.ts`](../../frontend/src/states/labels.ts)):

> Local to this install, and the interface says so where it matters: an IMAP
> keyword is not carried by every server and an Exchange category is a
> different thing again, so a label that appeared on one device and silently
> not on another would be worse than one that never claimed to travel.

The maintainer asked to add remote synchronization on top of this — a label
made in Oreneta should be visible in Gmail, Outlook, or another IMAP client,
and vice versa — while keeping the quick-filter-bar UI this ADR does not
design (separate issue). Three servers, three different shapes for what a
"label" is:

| Server | What exists | Colour | Scope |
|---|---|---|---|
| Gmail (IMAP) | `X-GM-LABELS`, gated behind the `X-GM-EXT-1` capability Oreneta already detects for `X-GM-THRID`/`X-GM-MSGID` ([`imap.rs:1786`](../../meron-core/src/imap.rs)) | Not exposed over IMAP | Per message |
| Exchange (EWS) | `item:Categories` on the item, plus a master category list on the mailbox | Yes, on the master list | Per item |
| Generic IMAP | Keywords (RFC 3501 §2.3.2), only usable if the server's `PERMANENTFLAGS` response includes `\*` | No | Per message |

Oreneta's label is per-**conversation**; every server's concept is per-
**message**. And the store is currently a flat `{id, name, colour}` with no
per-account field at all — the schema needs to grow, not just the sync logic.

The core already reconciles remote state for `\Seen`/`\Flagged` via CONDSTORE
([`sync_flags`, `imap.rs:941`](../../meron-core/src/imap.rs)), which is the
existing extension point this design follows rather than invents. Exchange's
`starred` is currently hardcoded `false` with a comment explaining the sync
path does not request the underlying MAPI property yet
([`exchange.rs:2040`](../../meron-core/src/exchange.rs)) — the categories
work in phase 6 of the approved plan is the natural place to close that gap
too, since both are "the sync path needs to ask for one more property."

## Decision

**Option A: a local label can carry an optional link to a remote concept,
per account, matched by name. The link is opt-in — an unlinked label behaves
exactly as it does today.**

### Data model

`Label` gains a `links: Record<accountId, RemoteLink>` map (empty by
default). A `RemoteLink` names what the label is bound to on that account:
a Gmail label name, an Exchange category name (and its GUID once created on
the mailbox's master list), or an IMAP keyword atom. A label with no entry
for an account is purely local on that account, with no behaviour change.

Linking is explicit, not automatic: the maintainer's earlier direction
("Depende de O-02" in the approved work plan) treats matching by name as a
one-time action the user takes per account — "link this label to the Gmail
label of the same name" — not a background heuristic that silently merges
two same-named-but-unrelated labels. The exact linking UI is a design
question for a later issue; this ADR only fixes what the link *means* once
made.

### Assign / read contract

- **Assigning** a linked label to a conversation writes it to **every
  message in the thread** on the linked account. A label is per-conversation
  locally and per-message remotely; there is no narrower remote unit to
  write to without inventing one the server doesn't have.
- **Reading** a linked label's membership on a conversation is the **union**
  across the thread's messages: if any message in the thread carries the
  remote label/category/keyword, the conversation shows the local label.
  This mirrors how `unread`/`starred` already roll up per-thread today.
- **Un-assigning** a linked label removes it from every message in the
  thread that currently carries it.

### Conflict rules

- **Membership** (is this label on this conversation) is decided by the
  server on every sync — the same rule `sync_flags` already applies to
  `\Seen`/`\Flagged`. A remote change always wins over what Oreneta last
  wrote; there is no local-wins mode.
- **Colour** is decided locally, **except for Exchange**, where the
  mailbox's master category list is authoritative — Exchange is the one
  protocol here that actually carries a colour, so overriding it locally
  would make the two disagree with no way to reconcile.
- **Creating** a link where the named remote label/category doesn't exist
  yet creates it on the server (Gmail: an IMAP `CREATE`-adjacent label
  operation; Exchange: an entry on the master category list) rather than
  silently failing to link.

### Unsupported servers

A plain IMAP account whose `PERMANENTFLAGS` response does not include `\*`
cannot carry a keyword-based link — the server has told the client, in
band, that it does not support arbitrary flags. Oreneta's settings must say
**"Not available on this account"** for that account, explicitly, rather
than hiding the link option with no explanation or silently dropping the
label on next sync. A label that appears to travel and does not is worse
than one that never claimed to, per the reasoning already in
`labels.ts` today — this ADR extends that reasoning to the remote case
instead of contradicting it.

### Order of implementation

Per the approved work plan: **Gmail first** (phase 2), since it is the
smallest gap to close (the `X-GM-EXT-1` capability detection already
exists) and the label-chips UI issue depends on having at least one working
protocol to filter against. **Exchange categories and IMAP keywords follow
in phase 6**, alongside closing the Exchange `starred`-always-false gap
noted above, since both are the same category of "sync path needs one more
property" work.

## Consequences

- The label store's contract grows from `{id, name, colour}` to include a
  per-account `links` map; every existing caller of `labels.list` /
  `labels.save` / `labels.assign`
  ([`main.rs:2121,2133,2157`](../../meron-core/src/main.rs)) must be
  reviewed against the new shape when phase 2 implements it — this ADR
  does not implement it.
- A conversation's label membership becomes, for linked labels, a
  server-decided fact discovered on sync rather than a purely local one —
  the UI must be able to show "this label was just removed remotely" the
  same way it already shows a read receipt arriving from another client.
- Assigning a linked label to a long thread is an N-message write, not a
  single-record write; this has sync-cost and rate-limit implications
  (particularly for Gmail) that the implementation issue must account for,
  not this ADR.
- Exchange is the only protocol where colour is not locally authoritative —
  documented here so a future "why doesn't changing this label's colour
  stick" bug report is answered by this record, not re-investigated.

## Alternatives considered

- **B — Import only, never write.** Simpler and lower-risk (no write path
  to a user's mailbox to get wrong), but does not deliver "synchronize,"
  which was the actual request; rejected as answering a different, smaller
  question than the one asked.
- **C — Per-account labels, no local concept.** Drops the ability to label
  a conversation consistently across accounts and breaks the existing rules
  engine, which assigns local labels
  ([`rules.go`](../../rules.go), `action_label` in
  [`main.rs:4999`](../../meron-core/src/main.rs)); rejected, since it
  removes a feature that exists today rather than only adding one.
- **Local wins on conflict, instead of remote wins.** Considered and
  rejected: a label is metadata about mail the user also reads in other
  clients, and letting Oreneta silently overwrite what another client just
  set would make Oreneta the odd one out, not the source of truth.
