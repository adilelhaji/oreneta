# Interoperability fixtures (#49)

Made by `make.sh` with the tools named in `VERSIONS` (GnuPG 2.4.4, OpenSSL
3.0.13), not with this codebase. Test material only; every key and
certificate here exists for these tests and nowhere else.

| File | How it was made |
|---|---|
| `pau_public.asc`, `pau_secret.asc` | `gpg --gen-key`, Ed25519 + Cv25519, no passphrase: Pau Interop <pau@example.test> |
| `olga_public.asc` | the same with `--faked-system-time 2020-01-01` and `Expire-Date: 2021-01-01` |
| `pgp_signed.eml` | `gpg --detach-sign` over the first part, assembled as RFC 3156 `multipart/signed` |
| `pgp_signed_tampered.eml` | the same, one character of the body changed afterwards |
| `pgp_signed_by_expired_key.eml` | signed by Olga at a faked 2020-06-01, while the key was valid |
| `pgp_encrypted_signed.eml` | `gpg --sign --encrypt` by Pau to the #12 fixture key, as `multipart/encrypted` |
| `sara.der`, `sara.p12` | `openssl req -x509` RSA-2048 email-protection certificate (Sara Interop <sara@example.test>), PKCS#12 with AES-256-CBC and password `interop` |
| `smime_signed_detached.eml` | `openssl smime -sign` (detached, SHA-256) |
| `smime_enveloped_aes256.eml` | `openssl smime -encrypt -aes256` (RSA PKCS#1 v1.5 key transport) |
| `smime_enveloped_oaep.eml` | `openssl cms -encrypt -keyopt rsa_padding_mode:oaep`: not implemented, must be named as such |
| `smime_authenveloped_gcm.eml` | `openssl cms -encrypt -aes-256-gcm` (AuthEnvelopedData): not implemented, must be named as such |

Everything under `testdata/` is `binary` in `.gitattributes`: the signatures
are over exact bytes, CRLF included.

**When a crypto dependency changes:**
- the tests in `interop_tests.rs` must pass unchanged;
- a fixture is never regenerated to make a test pass;
- `make.sh` is only re-run to add a fixture, recording the new tool
  versions.

The tests that hand Oreneta's output to `gpg` and `openssl` need both tools.
CI runners have them, and the tests fail there without them; on a machine
without them they say so and skip.
