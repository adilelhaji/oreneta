# Opening and selecting in the default mailbox table

Delivery [#154](https://github.com/adilelhaji/oreneta/issues/154), part of #34.
Preserves the approved shell, sortable columns, saved table/card preferences and
existing bulk operation contracts.

- Each desktop table row has a native checkbox. Click or Space selects it without
  opening or reading the conversation. The subject is a separate keyboard button.
- Opening a subject clears bulk selection and opens it using the same draft,
  starred-feed and active-tab behavior as cards. Ctrl/Command-click toggles a row;
  Shift-click explicitly selects the currently displayed range from the anchor.
- Existing bulk state retains exact selected identities. Arrivals do not join it
  automatically. The existing toolbar's Select all acts on currently loaded rows;
  it does not select unseen search results or create a continuing selection rule.
  While a set is selected, individual context menus are suppressed, matching the
  existing cards, so the toolbar's count cannot be confused with a single-row action.
- A left accent line identifies the open conversation, bold text identifies unread
  mail, checkboxes and tint identify bulk selection, and the focus outline identifies
  the keyboard target. These states can coexist. Rows retain table semantics.
- The compact table gives dates 80px and sender 27%; subject text takes the rest.
  Preview text no longer competes with the subject in the same line. Subject and
  sender tooltips preserve their full text, with at most one visible label and the
  remaining label count. Icons use theme colors and the shared scale.

`baseline/tableSelection.test.tsx` verifies selection, arrivals, ranges, context
menu scope, opening while
selecting, compose-tab exit, drafts and starred feeds. Production-entry browser
tests exercise keyboard selection and opening in cobalt light/dark at 1440px and
720px (the existing 200% desktop zoom-equivalent CSS width), saving screenshots.
The existing boundary suite still checks reader/composer navigation around 769px
and 1024px. Browser fixtures are synthetic, not native/provider certification.

#34 remains open for broader card-list polish, native zoom/accessibility evidence,
bulk progress/partial-outcome presentation and verified undo. Column configuration
remains #36. This change does not replace an executable or publish a release.
