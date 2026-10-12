# Proponer otra hora y coincidencias (#102, ADR-0043)

## Uso

- **Invitación recibida:** debajo de las respuestas, **Proponer otra hora**
  abre inicio, fin (o el día, si es de día entero) y una nota para el
  organizador. **Enviar propuesta** manda la propuesta; el calendario propio
  no cambia. Si el fin no es posterior al inicio, se dice y no se puede
  enviar. Si el envío falla, se dice qué falló y se puede volver a pulsar.
- **Propuesta recibida, como organizador:** la tarjeta dice quién propone qué
  hora y su nota.
  - **Abrir en el editor** abre el evento propio con la hora propuesta.
  - **Rechazar la propuesta**, con una nota opcional, se lo dice a quien la
    hizo.
  - Guardar en el editor cambia solo el calendario propio: en calendarios
    locales y CalDAV no se avisa a los asistentes, y la tarjeta lo advierte.
  - Si la reunión no se organiza en un calendario guardado aquí, la tarjeta
    solo informa. Si la propuesta es de una versión anterior, aparece como
    antigua y sin botones.
- **Rechazo recibido:** «El organizador rechazó la hora que propusiste», con
  su nota.
- **Coincidencias:** el editor, la tarjeta de una invitación, el formulario
  de propuesta y la tarjeta de una propuesta muestran «Coincide con: A, B, C
  y N más» cuando la hora se solapa con eventos propios.

## Núcleo

- `meron-core/src/calendar/itip.rs`:
  - `counter` y `decline_counter` construyen los objetos;
  - `organized_event` encuentra el evento propio que organiza la cuenta;
  - `parse` lee además COMMENT y STATUS:CANCELLED.
- `meron-core/src/calendar/overlap.rs`: `overlapping(conn, cuenta o todas,
  inicio, fin, día entero, desfase, excluidos)`.
- `meron-core/src/calendar/mod.rs`: `events_with_uid`.
- `subscription.rs` guarda `TRANSP:TRANSPARENT` como `free`.
- Órdenes:
  - `invite.counter` devuelve `{proposal: {to, subject, ics}}`;
  - `invite.counterStatus` devuelve `{organizer, event, sequence,
    outdated}` y lee la SEQUENCE del servidor si el evento está en CalDAV;
  - `invite.declineCounter` devuelve `{reply: {to, subject, ics}}`;
  - `calendar.conflicts` devuelve `{conflicts: [{account, calendar_id,
    event_id, subject, start, end, all_day}]}`.
- El envío lo hace el frontend con `mail.send`, como las respuestas:
  adjunto `text/calendar; method=COUNTER` o `method=DECLINECOUNTER`.

## Frontend

- `states/invitations.ts`: `proposeTime`, `counterStatus`,
  `declineProposal` y `editWithProposal`.
- `states/conflicts.ts` y `components/calendar/ConflictNote.tsx`.
- `InvitationCard.tsx` y `EventEditor.tsx`. El editor ya no pregunta si
  avisar en calendarios locales y CalDAV, porque guardar ahí no avisa.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `calendar/itip/tests.rs` | COUNTER leído de nuevo: método, UID, SEQUENCE sin cambiar, solo el ATTENDEE propio, horas propuestas, COMMENT escapado, sin COMMENT si está vacío; día entero como `VALUE=DATE`; ocurrencia con RECURRENCE-ID; rechazos (fin no posterior, organizador, CANCEL, STATUS:CANCELLED, serie entera, versión antigua); DECLINECOUNTER leído de nuevo, sin hora, solo del organizador y solo para una propuesta; organizador encontrado por UID, la ocurrencia nombrada o la primera, y no para otro organizador, una suscripción, lo cancelado u otra cuenta |
| N1 `calendar/overlap/tests.rs` | Sin cancelados, libres, rechazados ni suscripciones; extremos que se tocan no coinciden; orden; varias cuentas o una; el propio evento excluido por UID, id importado, id CalDAV o serie; día entero según la zona de la persona, en ambos sentidos |
| N1 `subscription.rs` | `TRANSP:TRANSPARENT` se guarda como libre; lo demás, sin suponer |
| N1 despachador (`main.rs`) | Coincidencias con y sin el propio evento; propuesta al organizador y rechazada para una versión antigua o una reunión cancelada; como organizador, solo información sin el evento aquí y rechazo enviado a quien propuso cuando lo está |
| N2 `InvitationCard.test.tsx` | Proponer: campos, validación, carga exacta de `invite.counter`, adjunto `method=COUNTER` al organizador, coincidencias, fallo explicado y reintento, motivo del núcleo; organizador: rechazar con nota y adjunto `method=DECLINECOUNTER`, abrir el editor con la hora propuesta y coincidencias en el editor, guardar sin preguntar si avisar en un calendario local; propuesta antigua o ajena sin botones; rechazo recibido solo informa |
| N3 | Se mantienen las de Radicale de ADR-0018; no hay prueba N3 nueva |
| N5 pendiente | Outlook, Gmail y Apple Calendar recibiendo y enviando COUNTER y DECLINECOUNTER |

## Bloqueado

La disponibilidad de otras personas desde sus servidores queda fuera:
- Google necesita los registros OAuth propios;
- Radicale no tiene la bandeja de salida de CalDAV scheduling;
- `GetUserAvailability` de EWS necesita un servidor real.
