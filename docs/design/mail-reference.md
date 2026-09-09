# Mail workflow reference (#32)

## Scope and direction

The 2026-09-09 user instruction prioritizes an eM Client-like mail workspace.
The reference instantiates [art direction](art-direction.md), preserving cobalt /
navy, the existing type/radius scales and native Wails/Go/Rust architecture.
Reference: [eM Client desktop](https://es.emclient.com/), reviewed 2026-09-09.
No third-party artwork or product branding is copied.

This is a navigable design fixture, not a shipped mail implementation. It uses
the same synthetic account/messages as [the baseline](../baseline.md), production
CSS tokens and Lucide icons. Mail controls simulate local state only: no Wails,
network transport, credentials, account bootstrap or persistent preferences.

## Composition and acceptance

- Persistent labelled folders; a compact list and traditional full-width reader.
- Visible New message, Reply, Forward, Archive and Delete actions; selection
  checkboxes are distinct from unread weight, opened-row tint and keyboard focus.
- Table, multi-selection, composer and uncertain-send scenes are addressable.
- Uncertain send never reports success or offers automatic retry; the draft
  stays visible and editable. This illustrates a state, not delivery recovery.
- At 1440px show folders/list/reader; at 1024px reduce folder/list widths;
  at <=600px show one mail pane with explicit back navigation and folder access.
- Both themes use identical fixture data, including long names and subjects.
  Search, empty folders, selection, draft validation and recovery are interactive.
- Existing user defaults/preferences are untouched. Proposed production defaults:
  traditional reader and compact list; migrate only absent preferences, never
  overwrite saved chat/card/theme selections (#33–#35).

## Delivery boundaries

Reusable reference responsibilities: workspace navigation, message list/table,
reader actions, draft form, and delivery notice. Production adoption belongs to
#33–#36; calendar/contacts/tasks remain outside this mail reference (#38).
No claim of functional parity, provider validation or accessibility certification.

CI runs the reference Playwright cases through `bun run baseline:verify` alongside
the unchanged historical baseline. Open `/reference.html?scene=reader&theme=light`
on the isolated baseline server. Screenshots include tested SHA, dirty-tree flag,
fixture checksum, theme, viewport and synthetic transport provenance.

## Verification record

Windows: typecheck and all 62 initial Playwright baseline/reference cases passed.
Rendered light 1440px reader/table, dark 1024px uncertain-send and light 600px
reader were inspected. Review findings fixed: search typing stole focus; the
conversation summary incorrectly called a later reply "earlier". Follow-up tests
cover table sorting/selection and composing while the narrow folder menu is open.
Final commit and CI evidence are recorded on the delivery PR. Local screenshots
record a dirty tree; they must not be described as a clean commit CI run.
