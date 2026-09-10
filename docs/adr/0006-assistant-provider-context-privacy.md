# ADR-0006: Explicit assistant provider and context boundary

- Status: accepted
- Date: 2026-09-10
- Scope: issue #51 / capability C24
- Approval: user approved the local-first plus explicit remote-provider recommendation on 2026-09-10

## Decision

Oreneta exposes an assistant through a provider-neutral contract with two
explicit modes:

1. **Local-first**: a configured local provider receives the selected context
   without leaving the device. If no local provider is configured, the action
   is unavailable rather than silently falling back to a network service.
2. **Remote provider**: a user-configured endpoint is opt-in per action. The
   request declares the provider, endpoint, model identifier and selected
   context. Oreneta does not host a model or proxy requests through an Oreneta
   service.

The UI must show a reviewable context manifest before activation. Only the
messages and attachments explicitly selected for that action may be sent.
Subject, sender and body are treated as untrusted input; instructions found in
mail never authorize sending, deleting, moving, filing, changing rules or
calling another tool.

The contract supports cancellation, bounded input size, provider errors and an
explicit offline failure. Requests and responses are not persisted by the
assistant layer. Provider credentials remain in the existing secret boundary;
provider responses are held only for the active action unless the caller saves
the result as ordinary user-authored content.

## Consequences

- Provider adapters can be added without changing mail storage or account
  synchronization.
- Remote use is auditable at the action boundary and cannot become a hidden
  background mailbox indexer.
- A local provider is the privacy-preserving default but requires the user to
  install/configure a compatible runtime; no model runtime is bundled by this
  ADR.
- Implementations of summaries, drafts and task extraction remain a separate
  work package (#52) and must consume this contract rather than bypass it.

## Non-goals

- No Oreneta-hosted AI service, subscription, telemetry or remote mailbox
  indexing.
- No automatic actions derived from message content.
- No provider-specific SDK or credential flow is selected by this ADR.

