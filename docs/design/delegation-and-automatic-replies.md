# Buzones delegados y respuestas automáticas (#48)

Verificación del comportamiento actual. Separa lo que se comprueba en código y
pruebas de lo que necesita cuentas delegadas reales.

## Buzones compartidos

- **Credenciales.** Un buzón compartido se guarda como una cuenta normal con
  `delegate_account_id` y `target_mailbox`, y contraseña vacía
  (`account.addSharedMailbox`). Al usarse toma en memoria las credenciales de
  la cuenta delegada (`resolve_delegate`). La contraseña del delegado nunca se
  copia al buzón compartido ni a su entrada del llavero.
- **Sin credenciales del delegado.** Si el delegado no tiene secreto propio o
  no es Exchange, el buzón no se resuelve y se informa que hay que reconectar
  la cuenta delegada. Lo cubren las pruebas `resolve_delegate` de
  `engine.rs`.
- **Graph.** Los buzones compartidos siguen sin soporte. La autorización Graph
  los rechaza al empezar (`graph.authBegin`), y el remitente solo puede ser la
  cuenta o un alias guardado.
- **Necesita cuentas reales.** Faltan por verificar:
  - acceso completo frente a «Enviar como» y «Enviar en nombre de»;
  - dónde queda la copia enviada (el buzón compartido o el del delegado);
  - qué ve el usuario cuando el administrador retira el permiso.
  Se hará con cuentas delegadas de prueba autorizadas (#98, filas de
  `provider-acceptance-matrix.json`).

## Respuestas automáticas

- **Exchange.** Usa las respuestas automáticas del servidor
  (`GetUserOofSettings`/`SetUserOofSettings`), que funcionan con Oreneta
  cerrado.
- **IMAP/SMTP.** No hay mecanismo de servidor. La respuesta local solo
  funciona con Oreneta abierto, y Ajustes lo dice («solo mientras Oreneta está
  en marcha»).
- **Qué no recibe respuesta.** La respuesta local no contesta:
  - a sí misma;
  - a direcciones `noreply` y `donotreply`;
  - a otras respuestas automáticas (`Auto-Submitted` distinto de `no`);
  - a correo masivo o de lista (`Precedence` bulk/list/junk, `List-Id`,
    `List-Unsubscribe`).
  Contesta una vez por remitente y marca su respuesta con
  `Auto-Submitted: auto-replied`.

### Corregido en esta entrega

- **Rebotes.** Un rebote (`Return-Path: <>`, remitente `MAILER-DAEMON` o
  `postmaster`, `multipart/report`) recibía respuesta. Con el rebote de esa
  respuesta empezaba un bucle con el servidor. Ahora no se contesta (RFC 3834
  §2).
- **`X-Auto-Response-Suppress`.** La cabecera con `OOF` o `All`, que usan
  Outlook y Exchange, ahora se respeta. Si solo suprime acuses de lectura, sí
  se contesta.
- **`List-Post`.** Una lista que solo se identifica por esa cabecera ya no
  recibe respuesta.
- **Fechas.** Afectaba a IMAP y a Exchange:
  - la fecha elegida se mostraba en UTC, así que al este de UTC aparecía el
    día anterior;
  - la fecha final se guardaba como el inicio de ese día, así que «hasta el
    12» terminaba al empezar el 12.
  Ahora el día se lee en hora local y el final incluye el día entero, también
  en el cambio de hora (25 horas).

## Pruebas

- `oof.rs`: rebotes por ruta nula, por remitente y por `multipart/report`;
  supresión por `OOF` y `All`, y no por acuses de lectura; lista por
  `List-Post`; más los casos que ya existían.
- `OofSettingsCard.test.tsx`: el día elegido se muestra igual en Madrid, Los
  Ángeles, Tokio y UTC; la fecha final incluye todo el día local; un día de
  cambio de hora dura 25 horas; una fecha vacía no limita.

## Pendiente

- **Cuentas reales.** Toda la verificación con cuentas delegadas reales:
  «Enviar como», «en nombre de», copia enviada y retirada del permiso.
- **Graph.** Las variantes Graph de buzones compartidos y respuestas
  automáticas necesitan sus propios permisos (`Mail.Read.Shared`,
  `MailboxSettings.ReadWrite`), que son una ampliación del ADR-0004.
