# Verificación S/MIME: validez del certificado y `contentType` (#9)

## Fallos reproducidos

- **`contentType` no comprobado.** Con atributos firmados presentes, el
  verificador comprobaba `messageDigest` y la firma, pero no que el atributo
  `contentType` existiera ni que coincidiera con el tipo del contenido
  transportado (`eContentType`). Cambiando solo el tipo declarado del contenido
  de un mensaje real de OpenSSL, sin tocar contenido, resumen ni firma, el
  resultado era **firma buena**. El test
  `a_content_type_that_differs_from_the_signed_one_does_not_check_out` lo
  reproduce: sin la comprobación devuelve `good`; con ella, `bad`.
- **Periodo de validez ignorado.** Un certificado caducado o aún no válido
  producía `Good` o `ValidUntrusted`.
- **Bomba de tiempo en los tests.** El fixture `ana.der` caduca el 2027-09-05;
  los tests que verificaban con el reloj real habrían empezado a fallar ese día
  en cuanto se comprobara la validez. Ahora se evalúan en un instante fijo.

## Contrato

- Con atributos firmados, falta `contentType` → `Malformed`; `contentType`
  distinto de `eContentType` → `Bad`. Sin atributos firmados (RFC 5652 lo
  permite para `id-data`) no se exige.
- Nuevo veredicto `CertificateNotValid { reason: expired | notYetValid,
  notBefore, notAfter, trusted }`: la firma es íntegra y el certificado no era
  válido en el momento de la comprobación. Nunca se presenta como firma válida.
  `trusted` sigue informando aparte si el lector tiene ese certificado.
- Integridad, validez temporal y confianza manual son tres hechos distintos y la
  interfaz los muestra por separado: `CertificateNotValid` se ve como aviso con
  la fecha de caducidad o de inicio, nunca con el escudo de firma correcta.
- La validez se juzga en el instante de la comprobación, no en el `signingTime`
  que declara el mensaje: lo escribe el firmante y no prueba nada. Los extremos
  del intervalo son válidos (RFC 5280 §4.1.2.5). Un intervalo ilegible cuenta
  como no válido.
- `verify_signed_data_at` y `verify_message_at` reciben el instante; las
  funciones públicas existentes usan el reloj del sistema.

## Fixtures

`meron-core/src/crypto/testdata/validity/`: tres certificados autofirmados
generados con OpenSSL 3.0.13 (`openssl ca -selfsign` con fechas explícitas) y
un mensaje opaco firmado con cada uno por `openssl smime -sign`, verificado con
`openssl smime -verify -noverify`. Los casos de `contentType` se construyen en el
test modificando la estructura CMS de uno de esos mensajes reales.

## Límites que siguen abiertos

- No hay construcción de cadena hasta una CA, ni comprobación de revocación
  (CRL/OCSP). La confianza sigue siendo «el lector tiene este certificado».
  Añadir cualquiera de las dos es una decisión de arquitectura (#49).
- No se comprueba `keyUsage`/`extendedKeyUsage` del certificado firmante.
- Firmas ECDSA y Ed25519 siguen siendo `NoKey` (algoritmo no soportado).
