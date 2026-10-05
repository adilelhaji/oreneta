# Shared dialog focus lifecycle (#158)

Part of #37. The shared `Dialog` shell now focuses its named section when opened,
unless a child already obtained explicit autofocus. Each instance has a unique
title ID, including when two dialogs have identical titles.

Closing restores focus to the connected, enabled opener if the dialog still
owned focus. It does not steal focus from a newer surface or focus removed,
hidden/inert or disabled triggers. When the opener has disappeared, no unrelated
action is chosen as a replacement. Restoration does not scroll the page.

A busy dialog remains registered in the existing Escape stack: it consumes the
key without closing itself or a parent underneath. The close button and backdrop
retain their existing busy restrictions.

Unit tests cover initial focus, autofocus, duplicate names, close/Escape, removed
or disabled triggers, StrictMode effect replay, another surface owning focus and a nested busy dialog.
The production-entry browser test walks the catalogue example with Tab, Space,
Enter and Escape and verifies return focus after keyboard and pointer dismissal.

This is a lifecycle increment, not a full modal accessibility claim. Tab focus
containment, portalled menus, custom dialog shells, simultaneous layer ordering
and native screen-reader evidence remain under #37. No focus trap or new modal
manager is introduced by this change.
