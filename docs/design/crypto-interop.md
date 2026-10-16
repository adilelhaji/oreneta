# Interoperabilitat d'OpenPGP i S/MIME (#49)

## Què s'ha comprovat amb eines independents

| Direcció | OpenPGP (GnuPG 2.4.4) | S/MIME (OpenSSL 3.0.13) |
|---|---|---|
| Ells signen, aquí es verifica | Correcta; canviada després, és «dolenta»; sense clau, «sense clau» (no «dolenta»); signada amb una clau avui caducada però vàlida en signar, correcta | Correcta amb el certificat acceptat; sense acceptar-lo, «vàlida però no de confiança» |
| Ells xifren, aquí s'obre | Xifrat i signat: s'obre amb la signatura interior verificada | AES-256-CBC amb RSA PKCS#1 v1.5: s'obre |
| Aquí se signa, ells verifiquen | `gpg --verify`: signatura correcta | `openssl smime -verify`: correcta |
| Aquí es xifra, ells obren | `gpg --decrypt`: s'obre i la signatura interior és correcta | `openssl smime -decrypt`: s'obre |

## Defectes trobats i corregits

- Els missatges signats o xifrats sortien amb **dos `MIME-Version`**: el del
  missatge i el de l'embolcall. Ara només el de l'embolcall.
- La signatura separada d'OpenPGP sortia armada com a `PGP MESSAGE`; ara és
  `PGP SIGNATURE`, com esperen els lectors de l'RFC 3156.
- A S/MIME, RSAES-OAEP, AES-GCM (AuthEnvelopedData) o un xifratge desconegut
  s'informaven com a missatge malmès. Ara són «no compatible» i s'anomena
  l'algorisme.

## Estats que es distingeixen

| OpenPGP | S/MIME |
|---|---|
| correcta, dolenta, sense clau, il·legible, signant diferent del remitent | correcta, vàlida però no de confiança, certificat caducat o encara no vàlid, dolenta, sense certificat, signant diferent del remitent |
| desxifratge: sense clau, falta la contrasenya, no compatible (AEAD de LibrePGP), malmès | desxifratge: sense clau, no compatible (amb l'algorisme), malmès |

## Sempre

- **Mai en clar:** si s'ha demanat xifrar i falta un certificat, l'enviament
  s'atura i anomena a qui falta.
- **Sense claus als informes:** la descripció d'una clau o identitat no porta
  material de la clau, i una contrasenya equivocada no repeteix res del que
  s'ha llegit.
- **Fora d'abast:** confiança implícita en CA corporatives i consultes de
  revocació (CRL o OCSP); necessiten una decisió pròpia de xarxa i de
  privadesa.

## Proves

`meron-core/src/crypto/interop_tests.rs`, amb les dades i la seva procedència a
`testdata/interop/README.md`. La part web és a `smimeDecrypt.test.ts`. La
interoperabilitat amb Outlook i Thunderbird en comptes reals és N5.
