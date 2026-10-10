# S/MIME validity fixtures (#9)

Made with OpenSSL 3.0.13, not with this codebase. Each certificate is a
self-signed RSA-2048 email-protection certificate for
`Oriol Fixture <oriol@example.test>`, issued with `openssl ca -selfsign`
and explicit `-startdate`/`-enddate`:

| File | notBefore | notAfter |
|---|---|---|
| `valid.der` | 2026-01-01 | 2099-01-01 |
| `expired.der` | 2020-01-01 | 2021-01-01 |
| `notyet.der` | 2090-01-01 | 2091-01-01 |

Each `.eml` is `openssl smime -sign -nodetach` (opaque signing, with signed
attributes) over a short text part with that certificate, and passed
`openssl smime -verify -noverify` before it was committed. The private keys
were discarded; these are test material only.
