# Settings and command discovery (#163 / #149)

## Inventory and scope

Before this change, the palette already supplied compose/sync/search/filter,
conversation, account/folder, board, theme and settings commands. Their labels
and synonyms were English literals. Its ASCII-only compaction treated a query
such as `日本語` as empty and returned every command. Settings had a general page,
account/board/calendar navigation, and existing controls with their own state;
it had no settings search or direct focus targets.

This delivery uses those actions and editors. The palette now has English and
Spanish labels/synonyms, distinguishes **Setting** from **Action**, and can jump
to appearance, typography, reading, global signature, assistant privacy,
configuration backup, supported update controls and exact account settings or
account signatures. Feed accounts do not advertise a signature. Updates are
only advertised when the host reports support. Privacy means the existing
assistant privacy controls, not a new all-purpose privacy center.

Other languages retain English fallback for the new catalog entries. User-given
account/folder/board/theme names remain intact. English aliases remain searchable
in Spanish. No new command engine, persistence model, provider capability or
automatic mail sending is introduced.

## Behavior

- Search folds case, accents and Unicode compatibility forms but retains letters
  from non-Latin scripts. Blank input lists everything; a nonblank query that
  reduces to no searchable characters never becomes a wildcard. Existing
  substring/subsequence matching remains available for real characters. Literal
  labels and aliases precede approximate matches, with stable ordering for ties.
- Both searches expose a named combobox and active option, arrow navigation,
  Enter activation, visible selection and empty results. Selected options scroll
  into view; long labels and hints wrap. Tab focus follows the actual option;
  confirming IME composition does not activate a result prematurely.
- Settings search navigates to existing mounted sections. Typing a query does
  not unmount editors or duplicate their state. Existing signature debounce and
  unmount flushing remain authoritative. Choosing an account changes the settings
  context without changing the mailbox being read; removed accounts are ignored.
- Palette close restores its connected, available opener before a command opens
  another surface. Settings reuses the shared dialog focus lifecycle. Returning
  focus does not imply a complete focus trap or native screen-reader certification.
- Graph write commands show their existing read-only restriction and remain
  inert; execution rechecks the current account capability. Existing state/backend
  guards remain in place. New-message composition remains available if any account
  can send, using the existing sender selection; it is disabled when none can.
  Discovery never grants a permission.
- Narrow settings stack navigation over the content instead of reserving a fixed
  side rail that leaves the editor unusably narrow. Preference values stay in the
  existing stores and only their existing controls change them.

## Evidence boundary

Unit tests cover accent/Unicode boundaries, live language changes and fallback,
exact account targeting/removal, feed/update capability availability, read-only
commands, empty results and focus return. Shared dialog tests retain StrictMode,
autofocus, opener removal and busy Escape coverage after extracting its lifecycle
hook for reuse. Review regressions cover Tab activation, IME confirmation, mixed
Graph/IMAP composition and capability changes before execution.

Production-entry tests use the existing synthetic bridge: English/Spanish,
light/dark, 600/1440px, keyboard, 200% CSS zoom, signature preservation across
search/navigation/reload, account context and Graph no-write behavior. Broader
#149/#37 native and full-localization acceptance remains open. No executable,
installer, release, account enrollment or live mail experiment is part of this
delivery.

Local checks: typecheck, catalog validation and build passed; 930 unit/component
tests and two bundler checks passed. The complete initial browser run passed
71 production-entry and 63 baseline cases; all seven discovery cases passed again
after review fixes (the production suite now contains 72). Exact-commit CI remains
the integration gate. Existing chunk-size build warnings remain. Internal assistant
controls are not fully translated by this slice.
