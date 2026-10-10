# GnuPG-generated fixtures (#12)

Produced with stock GnuPG 2.4.4, not with Sequoia's `CertBuilder`, so the
decrypt path is exercised against a key shape real readers import.

- `fixture_secret_aead_prefs.asc`: `gpg --batch --gen-key` with `%no-protection`,
  `Key-Type: EDDSA`/`Key-Curve: ed25519`, `Subkey-Type: ECDH`/`Subkey-Curve:
  cv25519`, as GnuPG 2.4 creates it, including its default `pref-aead-algos`.
- `fixture_secret.asc`: the same key after `setpref` without AEAD preferences.
- `message_aead.asc`: `gpg --encrypt --armor` to the key with AEAD preferences;
  GnuPG writes a LibrePGP AEAD-encrypted data packet (tag 20, OCB).
- `message_seipd.asc`: the same plaintext encrypted to the key without AEAD
  preferences; GnuPG writes an MDC-protected packet (SEIPD v1).

Key identity: Oreneta Fixture <fixture@example.test>, no passphrase. Test
material only; never used anywhere else.
