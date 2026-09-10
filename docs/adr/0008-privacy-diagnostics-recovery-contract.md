# ADR-0008: Local diagnostics, configuration backup and staged updates

- Status: accepted
- Date: 2026-09-10
- Scope: issue #54 / capabilities C22 and C29
- Approval: user selected options 1-A, 2-A and 3-A on 2026-09-10

## Decision

1. **Diagnostics are local-only.** Oreneta keeps bounded local logs in the
   canonical `oreneta.log` file, redacts
   email addresses and credential-like values before display/export, and never
   sends telemetry by default. Export is explicit and user-reviewable.
2. **Backups remain configuration-only.** The existing backup format includes
   accounts, settings and feeds, omits cached mail, and includes secrets only
   when the user supplies a passphrase. Import must report failures instead of
   silently claiming recovery.
3. **Updates remain staged and user-confirmed.** The existing release manifest,
   payload-size limit, SHA-256 verification and staged install are retained.
   Automatic installation, remote telemetry and a new update service are
   non-goals.

## Consequences

- Privacy scope stays local and auditable without a new service or dependency.
- A configuration restore is smaller and safer, but it does not restore cached
  mail or provider sessions.
- Hash verification protects integrity; authenticity/signature policy and
  native rollback evidence remain separate follow-up work.

## Validation boundary

Synthetic tests may prove redaction, backup secret handling and update hash or
staging behavior. They cannot certify provider interoperability, native Windows
recovery or production update delivery.
