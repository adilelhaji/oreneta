# ADR 0005: Explicit spam judgments per message

Status: Accepted — 2026-09-10. The maintainer selected option A for issue #50.

## Decision

Persist the reader's explicit spam decision separately from the learned verdict.
Add a local `spam_judgments` table keyed by account and the stable local message
identity. Store one current decision (`spam` or `not spam`) per message. The
existing `messages.spam` column remains nullable derived state and is never used
as proof that the reader made a decision.

Repeatedly submitting the same decision is a no-op. Changing a decision first
removes the previous contribution from the sender and subject-word aggregates,
then applies the replacement inside one transaction. This keeps learning
idempotent and makes corrections reversible without inflating evidence.

The identity is the local `messages.id`, qualified by `account`; the account
foreign scope is enforced by the table key and lookup. A missing conversation
or message remains a no-op. No automatic move, server/Sieve adapter or new
provider behavior is introduced by this decision.

## Consequences

- Aggregate counters can be repaired by replaying the current judgment rows.
- A judgment survives re-judging and cannot be confused with a derived result.
- Existing accounts migrate without backfilling invented user decisions.
- The implementation must update aggregates transactionally and test duplicate,
  replacement, missing-message and account-isolation cases.

