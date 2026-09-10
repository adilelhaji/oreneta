# ADR-0007: Reviewable assistant results and cooperative cancellation

- Status: accepted
- Date: 2026-09-10
- Scope: issue #52 / capability C24
- Approval: user approved the summary/draft/task slices and execution-id cancellation on 2026-09-10

## Decision

Issue #52 consumes the provider boundary from ADR-0006 in three bounded slices:

1. **Summary** results are text plus optional source references. Sources carry
   the account and message identity from the reviewed context; unknown sources
   are displayed as unlinked text rather than guessed links.
2. **Draft** results are text placed into a new editable composer draft only
   after an explicit user action. Recipients and threading are derived from the
   selected message; sending is never part of the assistant operation.
3. **Task** results are suggestions shown to the user. Saving a suggestion
   calls the existing local linked-task contract only after confirmation. The
   existing one-open-task-per-thread rule remains unchanged; duplicate selected
   suggestions for one thread are coalesced into one note.

Providers return a JSON result envelope when available:

```json
{
  "text": "…",
  "sources": [{"account_id":"…","message_id":"…"}],
  "tasks": [{"account_id":"…","message_id":"…","title":"…","note":"…","due_at":null}]
}
```

Non-JSON provider output is retained as plain text without inferred sources or
tasks. The assistant layer never persists the envelope.

Each execution has a caller-generated `execution_id`. A cancel request marks
that execution cancelled; the transport is bounded by its existing timeout,
and the result is rejected both before dispatch and after the provider returns.
Late results cannot update the UI. This is cooperative cancellation at the
assistant boundary; interruptible provider transports remain future work.

## Consequences

- Summary provenance is explicit and account-scoped.
- Draft creation is reversible user editing, not an external mail action.
- Task extraction cannot silently create or multiply tasks.
- Provider-specific response adapters are not selected by this ADR.

## Non-goals

- No automatic send, delete, move, filing, rule changes or task creation.
- No persisted prompts, responses, credentials or mailbox-wide indexing.
- No change to the existing task schema or one-open-task-per-thread invariant.
