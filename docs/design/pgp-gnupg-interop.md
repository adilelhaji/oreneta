# Descifrado PGP con claves y mensajes de GnuPG (#12)

## Causa reproducida

Con una clave real generada por GnuPG 2.4.4 (EdDSA/cv25519, sin contraseña) y
un mensaje cifrado por `gpg --encrypt`, `decrypt_message` devolvía
`NeedsPassphrase`. Había dos causas distintas, ninguna relacionada con la
contraseña:

1. **Compresión desactivada.** `sequoia-openpgp` se compilaba sin las
   características de compresión. GnuPG comprime cada mensaje con ZLIB por
   defecto, así que el descifrado obtenía la clave de sesión y fallaba al
   descomprimir. Como la clave del lector había aparecido, el resultado se
   clasificaba como «falta la contraseña».
2. **Modo AEAD de LibrePGP.** Las claves que crea GnuPG 2.4 anuncian una
   preferencia AEAD, y GnuPG cifra entonces con el paquete 20 (OCB) de
   LibrePGP, que Sequoia no lee. La biblioteca se detiene en ese paquete sin
   pedir ninguna clave.

## Cambios

- `sequoia-openpgp` se compila con `compression-deflate` y `compression-bzip2`
  (implementaciones en Rust puro).
- `DecryptionFailure::NeedsPassphrase` solo se devuelve cuando una clave del
  lector estaba **bloqueada** y no se desbloqueó. Si la clave produjo la clave
  de sesión y el mensaje aun así no se abre, o la biblioteca se detiene ante un
  paquete que no entiende, el resultado es `Unsupported { detail }` con una
  explicación legible (para AEAD, cómo evitarlo desde el remitente).
- La interfaz muestra «Este mensaje usa un formato que Oreneta todavía no puede
  abrir: …» y no pide contraseña.

## Evidencia y límites

- Fixtures reales de GnuPG en `meron-core/src/crypto/testdata/gnupg/` con su
  procedimiento de generación. `a_gnupg_generated_unprotected_key_opens_a_gnupg_encrypted_message`
  reproduce el caso de la issue y pasa; `a_librepgp_aead_message_is_reported_as_unsupported_not_as_a_passphrase_problem`
  fija la clasificación del caso AEAD.
- **Abrir mensajes AEAD de LibrePGP sigue sin estar soportado.** Por defecto,
  GnuPG 2.4 lo usa con sus propias claves; hasta que Sequoia lo implemente, el
  lector recibe un motivo exacto en lugar de una petición de contraseña.
- Sigue vigente el límite ya documentado en `pgp_tests.rs`: claves
  Ed25519/Curve25519 de GnuPG **protegidas con contraseña** no se desbloquean
  con el backend `crypto-rust` de Sequoia 2.4.1.
- La revisión del mismo problema en S/MIME pertenece a #9 y #49.
