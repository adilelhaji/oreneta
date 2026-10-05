# General and per-folder columns (#160)

Implements accepted ADR 0009. In table view, **Columns** opens a draft editor:
choose General view or Only this folder, toggle visibility, move columns with
named up/down buttons, and enter widths from 64 to 640 CSS pixels. Subject remains
visible and can use automatic width. Save applies the draft; Close/Escape discards
it. Reset to default replaces the draft with the compact preset and still requires
Save. Use general view immediately removes that folder's exception.

The general view is inherited by every account/folder pair without an override.
An override is an independent snapshot. Updating the general layout does not
overwrite it. IDs are exact pairs, including the existing unified account/roles;
labels and display names are never storage keys. Search uses the current folder's
layout, not another override namespace.

Absent/invalid preferences retain the pre-existing proportional table. Explicit
configuration uses the approved compact preset (120px sender, automatic subject,
80px date, hidden 120px account). This distinction preserves existing users until
their first explicit save. Invalid layouts are rejected as a unit; invalid folder
entries are ignored and the first valid duplicate wins. Unknown future versions
are retained verbatim during hydration and unrelated changes; editing stays
disabled until an explicit reset of all column views or an app update.

`mailbox_views` uses the existing preference fetch/write path and does not write
on hydration. Only sender/subject/date headers sort, through the existing global
whole-result sort preference. Account displays the known account name/email and
does not pretend to sort. Selection remains outside configurable columns; the
opened marker sits on the required subject even when sender is hidden. Oversized
layouts scroll inside the existing list viewport, keeping paging and sticky
headers in the same scrolling surface.

Evidence includes validator boundaries and malformed/future versions; exact
account/folder isolation and inheritance; hydration/persistence; draft cancellation,
width errors and semantic error association; selection/open state with hidden
sender; production-entry browser tests for keyboard, reload, folder navigation,
future reset, light/dark, 600/1440px and 200% CSS zoom. Browser fixtures use synthetic
mail and the existing bridge contract; they do not certify native DB restart or
screen-reader behavior. New text is Spanish/English, with English fallback in the
other catalogs pending translation. #36 retains remaining column capabilities,
native acceptance and complete localization; no release is included.
