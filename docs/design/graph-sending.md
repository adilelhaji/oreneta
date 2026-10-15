# Envío por Microsoft Graph (#143)

Bajo [ADR-0004](../adr/0004-microsoft-graph.md), que autoriza `Mail.Send` como
permiso aparte, y sobre el contrato durable de envío de #29
([outgoing-mail-recovery.md](outgoing-mail-recovery.md)). No hay persistencia
nueva: cada envío Graph es un intento en `outgoing_attempts`, con los mismos
estados y la misma recuperación que SMTP y EWS.

## Permiso

- **Petición aparte.** «Permitir el envío» en Ajustes de la cuenta pide
  `Mail.Send` para esa cuenta. Si la cuenta ya tenía `Mail.ReadWrite`, se pide
  de nuevo, para no perderlo.
- **Lo concedido manda.** El marcador no secreto guarda
  `{"writes": bool, "send": bool}` según lo que devolvió Microsoft.
- **Renovación.** Pide el mismo conjunto que se tenía. Si se retiró el
  consentimiento, cae una vez a solo lectura.
- **Remitente.** Solo la cuenta con sesión iniciada. Buzones compartidos,
  «enviar como» y delegación quedan en #48: el núcleo rechaza cualquier
  remitente que no sea la dirección de la cuenta o un alias guardado, como
  hasta ahora.

## Envío

- **Mismo MIME.** Se construye con `smtp::build_submission`, el mismo que usa
  Exchange:
  - texto y HTML, adjuntos e imágenes en línea por `cid:`;
  - `Bcc` en las cabeceras, que el servidor quita antes de entregar;
  - firma o cifrado aplicados igual que en SMTP. Si no se pueden aplicar, no se
    envía.
- **Petición.** `POST /me/sendMail` con el MIME en base64
  (`Content-Type: text/plain`). Microsoft guarda la copia en Elementos
  enviados; la siguiente sincronización la trae.
- **Confirmación de entrega** ([ADR-0057](../adr/0057-graph-folder-moves-and-receipt-reports.md)):
  - `sendMail` con MIME no puede llevarla: es la propiedad
    `isDeliveryReceiptRequested` del mensaje. Cuando se pide y la cuenta
    tiene cambios (`Mail.ReadWrite`) además de envío, el mismo MIME se
    convierte en borrador (`POST /me/messages`), se marca (`PATCH`) y se
    envía (`POST /me/messages/{id}/send`, 202);
  - sin cambios, o sin pedirla, se envía como siempre por `sendMail` y el
    envío dice `delivery_receipt: "unsupported"` o `"none"`;
  - un fallo al crear o marcar el borrador es «no enviado»: se borra el
    borrador y el intento queda rechazado, nunca incierto; si pudo quedar
    una copia en Borradores, se dice. El envío del borrador sigue la tabla
    de abajo; un rechazo borra el borrador.
- **Límite.** El cuerpo de la petición admite hasta 4 MB. Un mensaje más
  grande se rechaza antes de enviar, con «demasiado grande para enviarlo por
  Microsoft Graph». Es un rechazo definitivo y no se ha enviado nada. Subir
  por sesiones de carga necesitaría borradores en el servidor y queda fuera.
- **Borradores en el servidor.** Las cuentas Graph no guardan borradores en
  el servidor en esta entrega. El compositor no lo intenta y el borrador se
  conserva en el almacén local de #170.
- **Respuesta rápida.** En IMAP, el texto de una respuesta rápida vuelve al
  regresar al hilo gracias a su borrador en el servidor. En Graph no hay ese
  borrador, así que se guarda en memoria por hilo al salir y se repone al
  volver; sin eso se perdería al cambiar de conversación. Sobrevive mientras
  la aplicación está abierta, no a un reinicio.

## Resultados

Cada estado se distingue como en #29:

| Respuesta | Estado | Reintento |
|---|---|---|
| 202 | `accepted` (aceptado para entrega; no es confirmación de entrega) | — |
| 400, 401, 403, 404, 413, 429 | `rejected` con el motivo (la petición no se aceptó) | Solo a propósito |
| Demasiado grande antes de enviar | `rejected` | Solo a propósito, tras reducirlo |
| Conexión perdida tras enviar, tiempo agotado, 5xx | `uncertain` | Nunca automático |

- **Incierto.** Un 5xx o un 504 pueden llegar después de que Microsoft
  aceptara el envío, así que no se toman como rechazo.
  - El intento incierto no se reintenta al arrancar ni en ninguna otra parte.
  - La interfaz ofrece «Enviar de nuevo» o «Marcar como resuelto».
  - Reenviar algo ya intentado exige `resend`, como en SMTP.
- **Doble activación.** Pulsar enviar dos veces sobre el mismo `Message-ID`
  encuentra el intento anterior y se detiene.
- **Cancelación.** El «deshacer envío» ocurre antes de llamar al núcleo, así
  que nunca llega a Graph.
- **Envío programado.** Las cuentas Graph no lo tienen todavía.

## Pruebas

- **Transporte** (servidor de bucle local):
  - ruta, cabeceras, `text/plain` y cuerpo en base64 que decodifica al MIME;
  - 202 aceptado;
  - 4xx rechazado con categoría, 429 con su espera y 5xx;
  - conexión perdida como incierta, enviada una sola vez;
  - tamaño excedido rechazado sin enviar nada;
  - una concesión sin `Mail.Send` no envía nada;
  - confirmación de entrega: borrador desde el MIME, `PATCH` con
    `isDeliveryReceiptRequested` y envío sin cuerpo; sin `Mail.ReadWrite` no
    se crea el borrador (#210).
- **Autorización:** flujo de envío con el conjunto pedido, nivel concedido en
  el marcador y renovación que conserva `Mail.Send`.
- **Núcleo:** el guardián deja pasar `send` solo con el permiso; la
  clasificación de fallos de Graph en incierto o rechazado; la confirmación
  de entrega se pide exactamente cuando la política lo dice, y un fallo
  antes de enviar es un rechazo (#210).
- **Interfaz:**
  - una cuenta Graph con permiso de envío puede elegirse como remitente;
  - sin él, no;
  - sus borradores no se guardan en el servidor.
- **Fuera de estas pruebas:** la entrega real con destinatarios dedicados y
  autorizados es evidencia de proveedor (#98), no de estos tests.
