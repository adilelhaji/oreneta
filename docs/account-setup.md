# Account setup assistant

Issue #79 adopts eM Client's email-first, guided setup and explicit manual
alternative, not its visuals, authentication registrations or provider claims.
[Reference](https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Accounts/Create%20New%20Account.htm).

First-run and Add account share two steps: email, then connection. Exact public
Google/Microsoft domains suggest the existing OAuth flow; other domains use the
existing IMAP/SMTP discovery. Custom corporate domains are not assumed to use
either provider: explicit Google/Microsoft shortcuts and manual Exchange remain
available. Provider authorization determines the final OAuth account address.

Manual setup retains IMAP/SMTP, Exchange and RSS. Back preserves the address;
starting another connection clears credentials and server settings. Discovery
must not overwrite user edits or populate a different address. Discovered/guessed
settings are not proof of authentication. Account save remains the connection
validation; errors preserve the form for correction. OAuth availability and
browser waiting are explained, not represented by unexplained disabled buttons.

No Go/Rust transport, OAuth scope, keyring, certificate-trust or edit/reconnect
contract changes. No new discovery network services. English/Spanish copy is
provided; other catalogs use English for new keys pending translation.
New-address validation does not retroactively reject existing account identities;
editing server settings with a blank password keeps the stored credential.

Verification: pure address/provider tests and production-entry browser tests
with explicit synthetic Wails replies cover validation, provider choices,
manual discovery, failed/successful save, back navigation and modal reuse.
First-run native smoke identifies the email input and both provider choices.
Back/close invalidates pending frontend OAuth callbacks; it does not revoke a
grant at the provider. No account is saved from a discarded callback. A new
attempt continues to use the backend's existing Begin/state validation.
Real-provider authorization and server interoperability are not simulated proof
of working credentials.
