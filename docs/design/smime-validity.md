# Verificació S/MIME: validesa del certificat i `contentType` (#9)

## Fallades reproduïdes

- **`contentType` no comprovat.** Amb atributs signats presents, el
  verificador comprovava `messageDigest` i la signatura, però no que l'atribut
  `contentType` existís ni que coincidís amb el tipus del contingut
  transportat (`eContentType`). Si es canviava només el tipus declarat del
  contingut d'un missatge real d'OpenSSL, sense tocar el contingut, el resum ni la
  signatura, el resultat era **signatura bona**. El test
  `a_content_type_that_differs_from_the_signed_one_does_not_check_out` ho
  reprodueix: sense la comprovació retorna `good`; amb la comprovació, `bad`.
- **Període de validesa ignorat.** Un certificat caducat o encara no vàlid
  produïa `Good` o `ValidUntrusted`.
- **Bomba de rellotgeria als tests.** El fixture (fitxer de prova) `ana.der` caduca el 2027-09-05;
  els tests que verificaven amb el rellotge real haurien començat a fallar aquell
  dia tan bon punt es comprovés la validesa. Ara s'avaluen en un instant fix.

## Contracte

- Amb atributs signats, falta `contentType` → `Malformed`; `contentType`
  diferent d'`eContentType` → `Bad`. Sense atributs signats (l'RFC 5652 ho
  permet per a `id-data`) no s'exigeix.
- Nou veredicte `CertificateNotValid { reason: expired | notYetValid,
  notBefore, notAfter, trusted }`: la signatura és íntegra i el certificat no era
  vàlid en el moment de la comprovació. No es presenta mai com a signatura vàlida.
  `trusted` continua informant a part de si el lector té aquest certificat.
- La integritat, la validesa temporal i la confiança manual són tres fets diferents
  i la interfície els mostra per separat: `CertificateNotValid` es veu com un avís
  amb la data de caducitat o d'inici, mai amb l'escut de signatura correcta.
- La validesa es jutja en l'instant de la comprovació, no en el `signingTime`
  que declara el missatge: l'escriu el signant i no prova res. Els extrems
  de l'interval són vàlids (RFC 5280 §4.1.2.5). Un interval il·legible compta
  com a no vàlid.
- `verify_signed_data_at` i `verify_message_at` reben l'instant; les
  funcions públiques existents fan servir el rellotge del sistema.

## Fixtures

`meron-core/src/crypto/testdata/validity/`: tres certificats autosignats
generats amb OpenSSL 3.0.13 (`openssl ca -selfsign` amb dates explícites) i
un missatge opac signat amb cadascun per `openssl smime -sign`, verificat amb
`openssl smime -verify -noverify`. Els casos de `contentType` es construeixen al
test modificant l'estructura CMS d'un d'aquests missatges reals.

## Límits que continuen oberts

- No hi ha construcció de la cadena fins a una CA, ni comprovació de revocació
  (CRL/OCSP). La confiança continua sent «el lector té aquest certificat».
  Afegir qualsevol de les dues és una decisió d'arquitectura (#49).
- No es comprova el `keyUsage`/`extendedKeyUsage` del certificat signant.
- Les signatures ECDSA i Ed25519 continuen sent `NoKey` (algorisme no compatible).
