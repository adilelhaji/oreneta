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

Sources checked 2026-09-09:
[Microsoft code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[ID claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
[OIDC validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation).
