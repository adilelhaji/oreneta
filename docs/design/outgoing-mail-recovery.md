# Recuperación de correo saliente sin reintentos a ciegas (#29)

Contrato de implementación de la primera slice de #29. Cubre envío inmediato,
envío programado y «enviar ahora» desde escritorio sobre SMTP y EWS. No cubre
todavía la ruta móvil (`send_mobile_message`), que sigue usando `smtp::send`
sin registro durable, ni promete entrega exactamente una vez.

## Tres resultados, no dos

Un envío SMTP termina de una de tres maneras y el motor las distingue por fase
en `smtp::submit`:

| Fase | Fallo | Clasificación | Qué significa |
|---|---|---|---|
| Conexión, EHLO, AUTH, `MAIL FROM`, `RCPT TO`, `DATA` | cualquiera | **rechazado** | Ningún byte del mensaje se transmitió; reintentar es seguro |
| Tras `354`, durante la transmisión del cuerpo | error de E/S o tiempo agotado | **incierto** | El servidor puede tener el mensaje completo |
| Respuesta final al terminador `.` | `4xx`/`5xx` | **rechazado** | El servidor respondió que no |
| Respuesta final al terminador `.` | sin respuesta, conexión perdida, respuesta ilegible | **incierto** | RFC 5321 permite que el servidor haya aceptado sin que la respuesta llegara |

El cuerpo se envía por el escritor de comandos del stream con dot-stuffing
propio, porque la llamada única `send` de la biblioteca no informa en qué fase
falló. Un mensaje que no sea UTF-8 válido vuelve a esa llamada única y todo
fallo posterior a la conexión se clasifica como incierto, por prudencia.

Para EWS no hay fase de datos: un error de E/S o de tiempo agotado tras enviar
la petición es incierto; una falta SOAP o un estado HTTP de rechazo, rechazado.

El marcador `smtp::UncertainSend` viaja como contexto `anyhow`; `is_uncertain`
lo detecta mediante `downcast_ref`, que atraviesa contextos anidados.

## Registro durable `outgoing_attempts`

Cada envío se escribe en la base **antes** del primer byte y se actualiza al
terminar. Identificador: el `id` de la fila programada para envíos programados;
el `Message-ID` del mensaje para envíos inmediatos (el cliente lo genera antes
de enviar). La carga guardada es la petición completa sin `passphrase`.

```text
sending ─┬─> accepted ──> archived
         ├─> rejected
         └─> uncertain ──> resolved
```

- `accepted` con `archive_error` es un mensaje enviado sin copia en Enviados.
  Sigue siendo enviado: nunca se presenta como «no enviado».
- Al arrancar, toda fila en `sending` pasa a `uncertain` con motivo explícito:
  el proceso murió con el envío en curso.
- `uncertain` solo lo cierra una persona (`mail.resolveOutgoing`). El motor no
  lo reintenta ni lo descarta.
- El historial cerrado (`rejected`, `archived`, `resolved`, `accepted` sin
  error de archivo) se poda a los 30 días. La duda nunca se poda.

## Guardas contra el reenvío a ciegas

- `send` con un `attempt_id` cuyo intento anterior pueda haber llegado
  (`sending`, `accepted`, `archived`, `uncertain`) devuelve
  `{ok:false, outcome:"already_attempted"}` salvo que la petición lleve
  `resend:true`. Esto protege también frente a una interfaz que reintente.
- El bucle de programados consulta el intento antes de enviar: `accepted` o
  `archived` → la fila se borra y se anuncia como enviada (H03 corregido);
  `uncertain` o `sending` → la fila deja de intentarse y se anuncia con
  `uncertain:true`; `rejected` o inexistente → se envía.
- Un resultado incierto de un programado no consume reintentos con backoff:
  se detiene de inmediato. «Enviar ahora» sobre esa fila exige `resend:true`.

## Interfaz

- `mail.send` devuelve `{ok, outcome, attempt_id, error}`; `outcome` es
  `archived`, `accepted`, `uncertain` o `already_attempted`. Un rechazo sigue
  siendo un error.
- Burbuja de respuesta rápida: estado `uncertain` con botón que abre
  «Pendientes de enviar»; «Reintentar» no actúa sobre ese estado.
- Editor completo: `UncertainSendError` en línea; el editor queda abierto con
  su contenido y el intento aparece en la lista.
- «Pendientes de enviar» lista intentos sin resolver con dos acciones:
  «Enviar de nuevo» (advierte de la posible duplicación y envía con
  `resend:true`) y «Marcar como resuelto». Los programados con resultado
  desconocido muestran la misma advertencia y reenvían con `resend:true`.
- Al resolver o reenviar con éxito, la burbuja correspondiente pasa a enviada.

## Límites declarados

- No hay deduplicación por `Message-ID` en el servidor ni garantía de entrega
  única; el documento solo evita que el cliente duplique por su cuenta.
- Un mensaje firmado con clave protegida por contraseña no puede reenviarse
  desde la lista (la contraseña no se guarda); hay que redactarlo de nuevo.
- La restauración tras reinicio recupera contenido, destinatarios, identidad y
  adjuntos del intento desde la base; no recupera el editor abierto (#170).
- Las pruebas de servidor SMTP falso y de maddy acreditan la clasificación y la
  guarda de duplicados en aislamiento; no certifican proveedores reales.

## Verificación

- Rust: `smtp::tests` (conexión perdida tras el cuerpo, rechazo tras el cuerpo,
  destinatario rechazado sin transmitir datos, dot-stuffing), `store::outgoing`
  (transiciones, arranque, poda, resolución) y `scheduled_send_precheck`.
- Go: paso del resultado por el puente, reenvío deliberado, nuevos manejadores;
  integración maddy: segundo `send` con el mismo `Message-ID` rechazado como
  `already_attempted` con una sola copia entregada, y entregado con `resend`.
- Frontend: `outgoingAttempts.test.ts`, casos de `compose.test.ts`,
  `scheduledSends.test.ts` y `MessageBubble.test.tsx`.
