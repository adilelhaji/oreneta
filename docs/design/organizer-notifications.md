# Avisar els assistents des de calendaris locals i CalDAV (decisió del 2026-10-12)

## Comportament

- En **desar** o **eliminar** un esdeveniment amb assistents en un calendari
  **local** o **CalDAV**, l'editor mostra el mateix diàleg que amb Google i
  Exchange (`NotifyAsk`): anomena cada destinatari i l'adreça des de la
  qual surt el correu («Sent by mail from …»).
  - **Send it / Send a cancellation:** s'envia un correu normal amb la part
    `text/calendar; method=REQUEST` (en desar) o `method=CANCEL` (en
    eliminar), un únic missatge per a tots els assistents.
  - **Save without telling anyone:** no s'envia res.
- La pregunta només apareix quan l'enviament és possible: cal un compte
  de correu que pugui enviar com a organitzador. Si l'esdeveniment ja indica un
  organitzador, ha de ser una identitat (adreça o àlies) d'un compte que
  envia; si no n'indica cap, es fa servir el compte del calendari o, si aquest no
  envia, el primer que sí que ho fa. Sense cap (per exemple, sense comptes de
  correu, o si l'organitza una altra persona), no es pregunta i es manté la nota
  «Editing it here does not notify them».
- Si l'esdeveniment té assistents i no té organitzador, l'editor el desa
  amb la identitat que enviarà com a organitzador.
- Google, Exchange i Graph no canvien: l'avís l'envien els seus servidors (`notify` a
  `calendar.update` / `calendar.delete`).

## Ordre i errors

- **Desar:** desar → construir (`invite.notify`, a partir de l'esdeveniment ja
  desat) → enviar. Si falla la construcció o l'enviament, l'esdeveniment queda
  desat i un avís diu que no s'ha avisat ningú i per què.
- **Eliminar:** construir la cancel·lació → eliminar → enviar. Es construeix
  abans perquè surt de l'esdeveniment desat, que l'eliminació esborra; s'envia
  després perquè una eliminació rebutjada (conflicte CalDAV, sense
  connexió) no anunciï la cancel·lació d'una reunió que es manté. Si no
  es pot construir, no s'elimina res i l'editor diu per què; si falla
  l'enviament, es diu que l'esdeveniment s'ha eliminat però que la cancel·lació
  no ha sortit.

## Nucli

- `invite.notify` rep `{account, calendar, event, scope
  (occurrence|series), method (request|cancel), me_addr, me_name, people}` i
  retorna `{notice: {method, to, subject, sequence, ics}}`.
  - `to`: assistents amb adreça, sense l'organitzador. Si l'esdeveniment anomena
    algú que no és a `people` (el que s'ha mostrat), es rebutja i no es
    construeix res.
  - Es rebutja si l'organitza una altra persona, si no queda ningú a qui avisar o
    si el calendari no és local ni CalDAV.
- `calendar/itip.rs`:
  - `organizer_notice(objecte, Notice, ocurrència, jo, ara)`: REQUEST amb
    la sèrie sencera (RRULE, EXDATE, excepcions i VTIMEZONE) o només una
    ocurrència amb el seu RECURRENCE-ID (la seva excepció, o l'ocurrència tal com
    la dona la sèrie); CANCEL amb STATUS:CANCELLED. Sense VALARM. ORGANIZER = jo
    si no n'hi ha; ATTENDEE sense resposta amb PARTSTAT=NEEDS-ACTION;RSVP=TRUE.
    DTSTAMP de l'enviament; plegat i escapament segons l'RFC 5545.
  - `local_object` i `local_uid`: l'objecte d'un esdeveniment local; UID = el
    seu id (`local:…`, que `events_with_uid` torna a trobar quan arriba una
    resposta o una proposta) o l'UID importat.
- **SEQUENCE:**
  - CalDAV: a l'objecte del servidor; cada desament l'incrementa (la sèrie a
    `patch_event`; una ocurrència passa a tenir-ne una més que la de la seva
    excepció anterior o la de la sèrie a `put_override`). REQUEST porta la desada;
    CANCEL, una més.
  - Local: a la columna `change_key` de l'esdeveniment (sense migració): 0 en
    crear-lo, +1 a cada `calendar.update`, comptant a partir del que s'ha desat i
    no del que tenia obert l'editor. `invite.counterStatus` la fa servir per
    marcar com a antiga una proposta d'una versió anterior.
- **Assistents a CalDAV:** es llegeixen (ATTENDEE amb PARTSTAT, i ORGANIZER
  també quan apareix una sola vegada) i s'escriuen: un esdeveniment nou els
  inclou; en editar s'hi afegeixen els nous i l'organitzador si hi falta, i només
  es treuen els que l'editor ha tret (`removed_attendees` a
  `calendar.update`). Qui l'editor no ha mostrat es conserva.
- Go: `invite.notify` a la llista de pas d'`app.go`, 30 s a
  `sidecar.go`; `calendar.go` passa `removed_attendees`.

## Frontend

- `states/organizerNotices.ts`: `mailsNotices`, `noticeSender`,
  `organizerFor`, `noticeRecipients`, `buildNotice`, `sendNotice`.
- `states/calendar.ts`: `saveEvent` i `deleteEvent` envien per correu en
  calendaris locals i CalDAV i passen `notify: false` al nucli.
- `EventEditor.tsx` també pregunta en local i CalDAV si hi ha remitent;
  `NotifyAsk` mostra l'adreça d'enviament.

## Proves

- Rust (`cargo test --lib calendar::`): `itip/tests.rs` (sèrie amb zona,
  excepcions i persones; una ocurrència amb excepció i sense; CANCEL amb
  SEQUENCE+1; només l'organitzador; ningú a qui avisar; organitzador
  afegit; esdeveniment local amb UID, SEQUENCE, escapament i plegat; ocurrència
  importada) i `ics/tests.rs` (persones en crear, afegir i treure només el que
  s'ha tret, SEQUENCE d'una excepció).
- Distribuïdor (`cargo test --bin meron-core the_organizer_of_a_local`):
  invitació i actualitzacions amb SEQUENCE creixent, rebuig de qui no
  s'ha mostrat i de qui no organitza, cancel·lació abans d'eliminar,
  calendari de compte rebutjat.
- Bun (`OrganizerNotices.test.tsx`, `InvitationCard.test.tsx`): CalDAV
  pregunta amb noms i envia un correu amb `method=REQUEST`; «Save
  without telling anyone» no envia res; eliminar construeix, elimina i
  envia `method=CANCEL`; una fallada en construir no elimina; es comunica una
  fallada en enviar; sense cap compte que enviï o amb un altre organitzador no es
  pregunta; Google continua amb `notify: true` i sense correu.
