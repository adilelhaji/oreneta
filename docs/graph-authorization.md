# Graph authorization contract (#127)

Implements accepted ADR-0004; no change to existing Outlook/Gmail OAuth.

- Desktop Go owns only the ephemeral loopback listener and browser launch.
  Rust owns PKCE/state/nonce, token exchange/refresh, identity verification and
  credential storage. No bearer/refresh token or authorization code is returned
  to frontend state, logs or preferences.
- A flow lasts ten minutes, is bound to its selected local account (if any),
  and consumes one valid callback. Cancellation/replacement invalidates the
  generation; a late exchange cannot commit. Wrong-state callbacks cannot
  consume a legitimate pending request.
- Only one unassociated new-account flow can be pending. Disconnect cancels
  unassociated flows too: their identity is not yet known, so none may recreate
  the removed grant after its token exchange completes.
- Request only `openid email profile offline_access` and Graph `Mail.Read`.
  Global Microsoft v2 endpoints only. HTTPS, no redirects, per-account proxy,
  bounded response and timeout. Errors expose local categories, not provider
  descriptions. Neither a password nor an application secret is requested.
- Validate RS256 using Microsoft's fixed v2 JWKS endpoint and `ring`; ignore
  token-supplied key URLs. Validate issuer/tenant, audience, expiry, nonce and
  immutable `(tenantId, objectId)`. Check an optional `at_hash`. Refresh uses
  the pinned principal; never reinterpret an Outlook token as a Graph token.
- Email is display/local association, not Microsoft identity. First association
  to an existing account requires the selected mailbox address to match the
  authenticated address; ambiguous aliases fail explicitly. Reconnection must
  retain the same tenant/object pair. No automatic alias/tenant merging or
  shared-mailbox `/me` mapping. New account creation is owned by #128.
- Store a versioned Graph-only record (principal, local association, client ID,
  granted scopes, access/refresh token, expiry) under a separate hashed keychain
  namespace. Existing keychain chunking/encryption stays in use. No mail-account
  secret, configuration, label, draft or cache is overwritten. Missing/disabled
  secure storage fails explicitly; malformed records never become empty grants.
- Before storing a Graph credential, journal a non-secret association marker in
  SQLite settings (`graph.grant.<hashed account>`). Account removal invalidates
  pending flows and deletes a journalled Graph grant before deleting account
  data; unavailable storage blocks removal of that grant. A failed token write
  may leave a harmless marker, which is removed after successful vault deletion.
  Ordinary accounts without a marker retain their existing removal behavior.
- Desktop account removal and Graph authorization startup share an asynchronous
  lifecycle lock. The selected account is checked while holding it; removal
  keeps it until the local account/cache has been deleted. A waiting startup
  cannot recreate an association from a stale account-existence check.
- Refresh is serialized with disconnect/reconnect for that grant. Persist a
  rotated refresh token before reporting success; omitted rotation retains the
  current token. Reauthentication, revoked consent and storage failure preserve
  the previous record; no blind retry. Local disconnect deletes Graph secrets
  only, not Microsoft's other sessions/IMAP grant.
- OAuth success means **authorized**, not an active mail account. #128 owns
  projection and activation. No real-provider verification is implied by tests.

Validation: synthetic signed JWT/JWKS, OAuth and keychain fixtures; expiry,
scope/resource/nonce/principal mismatch, cancellation/replay, refresh rotation,
storage failure and secret-free responses. Existing required CI remains the gate.
The HTTP fixture consumes POST bodies before closing its socket to avoid a
Windows unread-request reset masking the intended provider error response.

Sources checked 2026-09-09:
[Microsoft code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[ID claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
[OIDC validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation).
