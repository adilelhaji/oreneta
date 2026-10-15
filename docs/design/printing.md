# Printing (#35, #213)

Ledger row SET-05 (General → Print). Decisions: [ADR-0060](../adr/0060-print-options.md).

Code: `frontend/src/lib/print.ts`, `lib/printDocument.ts`, `lib/printOptions.ts`,
`states/printing.ts`, `components/dialog/PrintGroup.tsx`.

## What goes on paper

- `lib/printDocument.ts` builds one self-contained HTML page; `lib/print.ts`
  prints it from an off-screen iframe sandboxed without scripts. The app window
  itself is never printed.
- `states/printing.ts` (`printFromReader`) is the single path from the reader:
  - the conversation menu (⋯ → Print…) prints as the remembered options say;
  - a message's context menu (Print message…) prints only that message, with
    the remembered header and attachment choices.
- A draft (drafts folder) or a local copy not yet sent (undo window, failed
  send awaiting retry) carries a "Draft" / "Not sent" mark on paper wherever
  it prints.

## Options (Settings → General → Print)

Stored as one `print_options` row (`settings$.print`, `lib/printOptions.ts`);
each field falls back to its default on its own when read back.

| Option | Choices | Default |
|---|---|---|
| Header fields | subject heading, date, To, Cc, Bcc | all on except Bcc |
| Scope | whole conversation, one message | whole conversation |
| Order (conversation only) | oldest first, newest first | oldest first |
| Attachment list | on, off | on |

The sender (name and address) is always printed. The defaults reproduce the
printout as it was before the options existed. "One message" from the
conversation menu is its newest loaded message that is neither a draft nor an
unsent copy (the newest one, marked, if there is no other). Newest first is the
exact reverse of oldest first. Bcc, once turned on, stays on until turned off;
its hint says so.

## Guarantees kept under every option (#35)

- Remote images load only when the account loads them; the page carries its own
  Content-Security-Policy (no scripts, frames, forms). Tracking pixels, scripts
  and inline handlers are removed.
- What is left out is said at the top of the page: older messages that were not
  loaded (conversation scope), or that only one message of a longer
  conversation is printed (message scope). When the message's conversation is
  not loaded, the page says the rest of it, if any, is not printed, without
  claiming there is more.

Tests: `printDocument.test.ts` (every option and the guarantees across every
combination), `printOptions.test.ts`, `printing.test.ts`, `print.test.ts`,
`PrintGroup.test.tsx`, `MessageContextMenu.test.tsx`. Native print evidence
(Windows, N4) is out of scope here and stays with the ledger.
