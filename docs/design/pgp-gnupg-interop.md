# Desxifratge PGP amb claus i missatges de GnuPG (#12)

## Causa reproduïda

Amb una clau real generada per GnuPG 2.4.4 (EdDSA/cv25519, sense contrasenya) i
un missatge xifrat amb `gpg --encrypt`, `decrypt_message` retornava
`NeedsPassphrase`. Hi havia dues causes diferents, cap de relacionada amb la
contrasenya:

1. **Compressió desactivada.** `sequoia-openpgp` es compilava sense les
   característiques de compressió. GnuPG comprimeix cada missatge amb ZLIB per
   defecte, de manera que el desxifratge obtenia la clau de sessió i fallava en
   descomprimir. Com que la clau del lector hi havia aparegut, el resultat es
   classificava com a «falta la contrasenya».
2. **Mode AEAD de LibrePGP.** Les claus que crea GnuPG 2.4 anuncien una
   preferència AEAD, i aleshores GnuPG xifra amb el paquet 20 (OCB) de
   LibrePGP, que Sequoia no llegeix. La biblioteca s'atura en aquest paquet sense
   demanar cap clau.

## Canvis

- `sequoia-openpgp` es compila amb `compression-deflate` i `compression-bzip2`
  (implementacions en Rust pur).
- `DecryptionFailure::NeedsPassphrase` només es retorna quan una clau del
  lector estava **bloquejada** i no s'ha desbloquejat. Si la clau ha produït la
  clau de sessió i tot i així el missatge no s'obre, o la biblioteca s'atura
  davant d'un paquet que no entén, el resultat és `Unsupported { detail }` amb
  una explicació llegible (per a AEAD, com evitar-ho des del remitent).
- La interfície mostra «Aquest missatge fa servir un format que Oreneta encara no
  pot obrir: …» i no demana cap contrasenya.

## Proves i límits

- Fixtures (fitxers de prova) reals de GnuPG a `meron-core/src/crypto/testdata/gnupg/` amb el seu
  procediment de generació. `a_gnupg_generated_unprotected_key_opens_a_gnupg_encrypted_message`
  reprodueix el cas de l'issue i passa; `a_librepgp_aead_message_is_reported_as_unsupported_not_as_a_passphrase_problem`
  fixa la classificació del cas AEAD.
- **Obrir missatges AEAD de LibrePGP continua sense ser compatible.** Per defecte,
  GnuPG 2.4 fa servir aquest format amb les seves pròpies claus; fins que Sequoia no
  l'implementi, el lector rep un motiu exacte en lloc d'una petició de contrasenya.
- Continua vigent el límit ja documentat a `pgp_tests.rs`: les claus
  Ed25519/Curve25519 de GnuPG **protegides amb contrasenya** no es desbloquegen
  amb el backend `crypto-rust` de Sequoia 2.4.1.
- La revisió del mateix problema en S/MIME correspon a #9 i #49.
