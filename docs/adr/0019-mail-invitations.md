# ADR-0019: Invitaciones que llegan por correo (iMIP)

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #102.

## Contexto

Las invitaciones de Exchange y Google ya se contestaban desde su calendario,
por sus API. Una invitación recibida en una cuenta IMAP aparecía como un
adjunto `.ics` sin más. #102 exige que el correo recibido no autorice nunca a
contestar solo.

## Alternativas

1. **Leer, describir y actuar solo con un botón (elegida).** Con «Aceptar»,
   «Quizá» o «Rechazar» se guarda el evento en el calendario elegido (local o
   CalDAV) o se quita, y se envía la respuesta iTIP al organizador por la ruta
   normal de envío. Así queda registrada como intento de envío (#29), con
   copia en Enviados.
2. **Añadir automáticamente al calendario las invitaciones recibidas**, como
   hace Gmail. Es cómodo, pero llena el calendario con lo que llega de
   cualquiera y es un vector de spam conocido.
3. **Contestar desde el servidor de calendario (CalDAV scheduling).** Pocos
   servidores lo implementan, y no aplica a calendarios locales.

## Decisión

- **Lectura:** el analizador reconoce una parte `text/calendar` (o
  `application/ics`) con METHOD y guarda con el mensaje su descripción:
  método, UID, SEQUENCE, ocurrencia, asunto, lugar, primera hora,
  organizador y asistentes con su estado, y el objeto tal cual llegó.
- **Respuesta:** se construye según RFC 5546 §3.2.3 (UID, SEQUENCE,
  RECURRENCE-ID si la hay, ORGANIZER y solo el ATTENDEE propio con su
  PARTSTAT). Se envía como adjunto `text/calendar; method=REPLY` (RFC 6047),
  con el método como parámetro de verdad en el Content-Type.
- **Calendario:**
  - aceptar o «quizá» guarda el evento sin METHOD y con el PARTSTAT propio;
    en CalDAV como objeto propio y en local como sus ocurrencias;
  - rechazar lo quita;
  - una copia con SEQUENCE mayor no se sobrescribe.
- **Cancelación:** solo se quita al pulsar «Quitar de mi calendario».
- **Versiones:**
  - se guarda la última respuesta por cuenta y UID (`invitation_answers`,
    que se borra con la cuenta según ADR-0011);
  - una invitación con SEQUENCE menor que la ya contestada aparece como
    antigua y no ofrece botones;
  - la misma versión puede volver a contestarse, que es como se reintenta.
- **Fallo de envío:** si el calendario se actualizó pero la respuesta no
  salió, se dice exactamente eso, y volver a pulsar la envía.
- **Exchange y Google:** la tarjeta lo describe e indica que se conteste en
  el calendario de la cuenta, como antes.

## Pendiente

- Contraproponer: resuelto en ADR-0043 (COUNTER y DECLINECOUNTER).
- Reenviar una invitación.
- Disponibilidad (free/busy): las coincidencias con la agenda propia se
  resuelven en ADR-0043; la disponibilidad de otras personas desde los
  servidores sigue bloqueada (ver ADR-0043).
- Actualizar como organizador el estado de los asistentes al recibir
  respuestas: ahora solo se muestran.
- Verificación N5 con Outlook, Gmail y Apple Calendar.
