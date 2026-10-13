# Avisar a los asistentes desde calendarios locales y CalDAV (decisión del 2026-10-12)

## Comportamiento

- Al **guardar** o **eliminar** un evento con asistentes en un calendario
  **local** o **CalDAV**, el editor muestra el mismo diálogo que con Google y
  Exchange (`NotifyAsk`): nombra a cada destinatario y la dirección desde la
  que sale el correo («Sent by mail from …»).
  - **Send it / Send a cancellation:** se envía un correo normal con la parte
    `text/calendar; method=REQUEST` (al guardar) o `method=CANCEL` (al
    eliminar), un único mensaje para todos los asistentes.
  - **Save without telling anyone:** no se envía nada.
- La pregunta solo aparece cuando el envío es posible: hace falta una cuenta
  de correo que pueda enviar como organizador. Si el evento ya nombra un
  organizador, debe ser una identidad (dirección o alias) de una cuenta que
  envía; si no nombra ninguno, se usa la cuenta del calendario o, si esta no
  envía, la primera que sí. Sin ninguna (por ejemplo, sin cuentas de correo,
  o si organiza otra persona), no se pregunta y se mantiene la nota «Editing
  it here does not notify them».
- Si el evento tiene asistentes y no tiene organizador, el editor lo guarda
  con la identidad que enviará como organizador.
- Google, Exchange y Graph no cambian: avisan sus servidores (`notify` en
  `calendar.update` / `calendar.delete`).

## Orden y errores

- **Guardar:** guardar → construir (`invite.notify`, a partir del evento ya
  guardado) → enviar. Si falla la construcción o el envío, el evento queda
  guardado y un aviso dice que no se avisó a nadie y por qué.
- **Eliminar:** construir la cancelación → eliminar → enviar. Se construye
  antes porque sale del evento guardado, que la eliminación borra; se envía
  después para que una eliminación rechazada (conflicto CalDAV, sin
  conexión) no anuncie la cancelación de una reunión que sigue en pie. Si no
  se puede construir, no se elimina nada y el editor dice por qué; si falla
  el envío, se dice que el evento se eliminó pero la cancelación no salió.

## Núcleo

- `invite.notify` recibe `{account, calendar, event, scope
  (occurrence|series), method (request|cancel), me_addr, me_name, people}` y
  devuelve `{notice: {method, to, subject, sequence, ics}}`.
  - `to`: asistentes con dirección, sin el organizador. Si el evento nombra a
    alguien que no está en `people` (lo que se mostró), se rechaza y no se
    construye nada.
  - Se rechaza si organiza otra persona, si no queda nadie a quien avisar o
    si el calendario no es local ni CalDAV.
- `calendar/itip.rs`:
  - `organizer_notice(objeto, Notice, ocurrencia, yo, ahora)`: REQUEST con
    la serie entera (RRULE, EXDATE, excepciones y VTIMEZONE) o solo una
    ocurrencia con su RECURRENCE-ID (su excepción, o la ocurrencia tal como
    la da la serie); CANCEL con STATUS:CANCELLED. Sin VALARM. ORGANIZER = yo
    si no hay; ATTENDEE sin respuesta con PARTSTAT=NEEDS-ACTION;RSVP=TRUE.
    DTSTAMP del envío; plegado y escapado RFC 5545.
  - `local_object` y `local_uid`: el objeto de un evento local; UID = su id
    (`local:…`, que `events_with_uid` vuelve a encontrar cuando llega una
    respuesta o una propuesta) o el UID importado.
- **SEQUENCE:**
  - CalDAV: en el objeto del servidor; cada guardado la sube (la serie en
    `patch_event`; una ocurrencia pasa a ser una más que la de su excepción
    anterior o la de la serie en `put_override`). REQUEST lleva la guardada;
    CANCEL, una más.
  - Local: en la columna `change_key` del evento (sin migración): 0 al
    crear, +1 en cada `calendar.update` contando desde lo guardado y no desde
    lo que tenía abierto el editor. `invite.counterStatus` la usa para
    marcar como antigua una propuesta de una versión anterior.
- **Asistentes en CalDAV:** se leen (ATTENDEE con PARTSTAT, y ORGANIZER
  también cuando aparece una sola vez) y se escriben: un evento nuevo los
  incluye; al editar se añaden los nuevos y el organizador si falta, y solo
  se quitan los que el editor quitó (`removed_attendees` en
  `calendar.update`). Quien el editor no mostró se conserva.
- Go: `invite.notify` en la lista de paso de `app.go`, 30 s en
  `sidecar.go`; `calendar.go` pasa `removed_attendees`.

## Frontend

- `states/organizerNotices.ts`: `mailsNotices`, `noticeSender`,
  `organizerFor`, `noticeRecipients`, `buildNotice`, `sendNotice`.
- `states/calendar.ts`: `saveEvent` y `deleteEvent` envían por correo en
  calendarios locales y CalDAV y pasan `notify: false` al núcleo.
- `EventEditor.tsx` pregunta también en local y CalDAV si hay remitente;
  `NotifyAsk` muestra la dirección de envío.

## Pruebas

- Rust (`cargo test --lib calendar::`): `itip/tests.rs` (serie con zona,
  excepciones y personas; una ocurrencia con y sin excepción; CANCEL con
  SEQUENCE+1; solo el organizador; nadie a quien avisar; organizador
  añadido; evento local con UID, SEQUENCE, escapado y plegado; ocurrencia
  importada) y `ics/tests.rs` (personas al crear, añadir y quitar solo lo
  quitado, SEQUENCE de una excepción).
- Despachador (`cargo test --bin meron-core the_organizer_of_a_local`):
  invitación y actualizaciones con SEQUENCE creciente, rechazo de quien no
  se mostró y de quien no organiza, cancelación antes de eliminar,
  calendario de cuenta rechazado.
- Bun (`OrganizerNotices.test.tsx`, `InvitationCard.test.tsx`): CalDAV
  pregunta con nombres y envía un correo con `method=REQUEST`; «Save
  without telling anyone» no envía nada; eliminar construye, elimina y
  envía `method=CANCEL`; fallo al construir no elimina; fallo al enviar se
  dice; sin cuenta que envíe o con otro organizador no se pregunta; Google
  sigue con `notify: true` y sin correo.
