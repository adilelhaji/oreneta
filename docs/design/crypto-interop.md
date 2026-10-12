# Interoperabilidad OpenPGP y S/MIME (#49)

## Qué se comprobó con herramientas independientes

| Dirección | OpenPGP (GnuPG 2.4.4) | S/MIME (OpenSSL 3.0.13) |
|---|---|---|
| Ellos firman, aquí se verifica | Correcta; cambiada después es «mala»; sin clave, «sin clave» (no «mala»); firmada con una clave hoy caducada pero válida al firmar, correcta | Correcta con el certificado aceptado; sin aceptarlo, «válida pero no de confianza» |
| Ellos cifran, aquí se abre | Cifrado y firmado: se abre con la firma interior verificada | AES-256-CBC con RSA PKCS#1 v1.5: se abre |
| Aquí se firma, ellos verifican | `gpg --verify`: firma correcta | `openssl smime -verify`: correcta |
| Aquí se cifra, ellos abren | `gpg --decrypt`: se abre y la firma interior es correcta | `openssl smime -decrypt`: se abre |

## Defectos encontrados y corregidos

- Los mensajes firmados o cifrados salían con **dos `MIME-Version`**: el del
  mensaje y el del envoltorio. Ahora solo el del envoltorio.
- La firma separada de OpenPGP salía armada como `PGP MESSAGE`; ahora es
  `PGP SIGNATURE`, como esperan los lectores de RFC 3156.
- En S/MIME, RSAES-OAEP, AES-GCM (AuthEnvelopedData) o un cifrado
  desconocido se informaban como mensaje dañado. Ahora son «no compatible»
  y se nombra el algoritmo.

## Estados que se distinguen

| OpenPGP | S/MIME |
|---|---|
| correcta, mala, sin clave, ilegible, firmante distinto del remitente | correcta, válida pero no de confianza, certificado caducado o aún no válido, mala, sin certificado, firmante distinto del remitente |
| descifrado: sin clave, falta la contraseña, no compatible (AEAD de LibrePGP), dañado | descifrado: sin clave, no compatible (con el algoritmo), dañado |

## Siempre

- **Nunca en claro:** si se pidió cifrar y falta un certificado, el envío se
  detiene y nombra a quién falta.
- **Sin claves en los informes:** la descripción de una clave o identidad
  no lleva material de la clave, y una contraseña equivocada no repite nada
  de lo leído.
- **Fuera de alcance:** confianza implícita en CA corporativas y consultas
  de revocación (CRL u OCSP); necesitan su propia decisión de red y de
  privacidad.

## Pruebas

`meron-core/src/crypto/interop_tests.rs`, con los datos y su procedencia en
`testdata/interop/README.md`. La parte web está en `smimeDecrypt.test.ts`.
La interoperabilidad con Outlook y Thunderbird en cuentas reales es N5.
