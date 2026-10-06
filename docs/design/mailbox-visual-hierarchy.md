# Mailbox table visual hierarchy (#186)

Small visual refinement under #34, retaining the approved shell and saved views.

- A softly shaded sticky header separates column controls from messages.
- Rows have a 36px minimum height; sender, subject and date retain the existing
  type scale and columns. Long content still truncates with full-text tooltips.
- Unread subjects have an accent dot and bold text. The dot's space is retained
  for read messages so subjects align; the accessible unread label is unchanged.
- A 3px inset edge at the start of the opened row stays visible alongside bulk
  selection. It follows the row rather than a particular configurable column.
- Unread rows have a subtle tint. Opened and bulk-selected backgrounds take
  precedence; checkbox, edge, dot and keyboard outline remain separate signals.
- Shared theme colors support saved themes, including dark mode. No preference,
  mailbox state, sorting, selection, protocol or account behavior changes.
- In forced-colors mode, system-color borders preserve the opened edge and
  unread dot when background tints and shadows are suppressed.

Verification: component state transitions and production-entry browser scenarios
for light/dark at desktop and narrow widths, with keyboard opening/selection,
column reordering and rendered screenshots. These synthetic scenarios do not
certify native zoom or real providers and do not replace the installed executable.
