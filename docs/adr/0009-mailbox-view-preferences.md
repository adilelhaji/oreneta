# ADR 0009: Mailbox view preferences

Status: Accepted — 2026-10-05. The user approved "Aprobar vista general y
excepciones por carpeta" in the #36 implementation conversation, after reviewing
the [concrete contract](../design/mailbox-view-preferences-proposal.md).

Use one versioned `mailbox_views` preference through the existing settings path.
A global column layout is inherited unless an exact account/folder pair has an
explicit independent override. Resetting a folder removes its override; changing
the global layout does not overwrite customized folders. No new database, remote
service or sync mechanism.

Initially expose sender, subject, date and account. Subject remains visible;
selection controls stay outside the layout. Only sender/subject/date sort, using
ADR 0003's whole-result ordering. Account is display-only. Unsupported metadata
and new sort capabilities remain outside this decision.

Validate version, identifiers, duplicate columns and widths before use. Preserve
unknown future versions without silent writes. Existing users without this
preference retain the current compact layout. Keyboard configuration, scoped
horizontal scrolling, explicit reset and restart/account-isolation tests are
required. The contract document defines detailed defaults and boundaries.

Implementation proceeds in bounded reviewed issues with green CI. Approval does
not authorize releases, provider changes or full-parity claims.
