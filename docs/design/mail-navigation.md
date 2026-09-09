# Production mail navigation (#34)

First adoption of the [mail reference](mail-reference.md), authorized by the
2026-09-09 user instruction to integrate labelled accounts and folders.

- A persistent 220px navigation panel accompanies the existing account rail in
  mail views wider than 1024 CSS pixels. At smaller widths, existing folder and
  account selectors remain available; no modal or new navigation state is added.
- Account destinations use `openMailAccount`; real folder IDs use the existing
  selected-folder state. Query, pinned filters, sorting and draft preferences
  follow existing behavior. Navigation explicitly clears bulk selection and the
  opened message so actions cannot silently target the previous mailbox.
- Folder hierarchy reuses `buildFolderTree`, including server delimiters and
  non-selectable structural parents. Labels and unread counts come from the
  selected account's cache; stale folders from another account are never shown.
- Unified folders use existing role IDs and aggregate inbox counts only for
  included accounts. RSS retains its feed inbox rather than fictitious folders.
- Account visibility respects rail preferences, but the currently selected
  account remains reachable even if hidden. Folder updates are observed from the
  existing cache; the panel adds no provider calls or alternative loading logic.
- Calendar, contacts, tasks and Kanban retain their existing full-width views.

This slice does not close #34: row density/selection feedback, 200% zoom and the
known exact-600px reader boundary still require their own acceptance evidence.
No theme or reader-default migration is included. Tests cover the real production
entry with synthetic bridge replies; they do not certify provider connectivity.

English/Spanish labels are provided; the other catalogs use explicit English
fallback strings pending translation, following the existing catalog contract.
