# Proposar una altra hora i coincidències (#102, ADR-0043)

## Ús

- **Invitació rebuda:** sota les respostes, **Proposa una altra hora** obre
  l'inici, la fi (o el dia, si és de dia sencer) i una nota per a
  l'organitzador. **Envia la proposta** envia la proposta; el calendari propi
  no canvia. Si la fi no és posterior a l'inici, s'indica i no es pot enviar.
  Si l'enviament falla, s'indica què ha fallat i es pot tornar a prémer.
- **Proposta rebuda, com a organitzador:** la targeta indica qui proposa quina
  hora i la seva nota.
  - **Obre a l'editor** obre l'esdeveniment propi amb l'hora proposada.
  - **Rebutja la proposta**, amb una nota opcional, ho comunica a qui l'ha
    feta.
  - En desar a l'editor, si l'esdeveniment té assistents, es pregunta si cal
    avisar-los, també en calendaris locals i CalDAV (vegeu
    `organizer-notifications.md`); la targeta ho adverteix.
  - Si la reunió no s'organitza en un calendari desat aquí, la targeta només
    informa. Si la proposta és d'una versió anterior, apareix com a antiga i
    sense botons.
- **Rebuig rebut:** «L'organitzador ha rebutjat l'hora que vas proposar», amb
  la seva nota.
- **Coincidències:** l'editor, la targeta d'una invitació, el formulari de
  proposta i la targeta d'una proposta mostren «Coincideix amb: A, B, C i N
  més» quan l'hora s'encavalla amb esdeveniments propis.

## Nucli

- `meron-core/src/calendar/itip.rs`:
  - `counter` i `decline_counter` construeixen els objectes;
  - `organized_event` troba l'esdeveniment propi que organitza el compte;
  - `parse` llegeix, a més, COMMENT i STATUS:CANCELLED.
- `meron-core/src/calendar/overlap.rs`: `overlapping(conn, compte o tots,
  inici, fi, dia sencer, desfasament, exclosos)`.
- `meron-core/src/calendar/mod.rs`: `events_with_uid`.
- `subscription.rs` desa `TRANSP:TRANSPARENT` com a `free`.
- Ordres:
  - `invite.counter` retorna `{proposal: {to, subject, ics}}`;
  - `invite.counterStatus` retorna `{organizer, event, sequence,
    outdated}` i llegeix la SEQUENCE del servidor si l'esdeveniment és a
    CalDAV;
  - `invite.declineCounter` retorna `{reply: {to, subject, ics}}`;
  - `calendar.conflicts` retorna `{conflicts: [{account, calendar_id,
    event_id, subject, start, end, all_day}]}`.
- L'enviament el fa el frontend amb `mail.send`, com les respostes: adjunt
  `text/calendar; method=COUNTER` o `method=DECLINECOUNTER`.

## Frontend

- `states/invitations.ts`: `proposeTime`, `counterStatus`,
  `declineProposal` i `editWithProposal`.
- `states/conflicts.ts` i `components/calendar/ConflictNote.tsx`.
- `InvitationCard.tsx` i `EventEditor.tsx`. L'editor ja no pregunta si cal
  avisar en calendaris locals i CalDAV, perquè desar-hi no avisa.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `calendar/itip/tests.rs` | COUNTER tornat a llegir: mètode, UID, SEQUENCE sense canviar, només l'ATTENDEE propi, hores proposades, COMMENT escapat, sense COMMENT si és buit; dia sencer com a `VALUE=DATE`; ocurrència amb RECURRENCE-ID; rebutjos (fi no posterior, organitzador, CANCEL, STATUS:CANCELLED, sèrie sencera, versió antiga); DECLINECOUNTER tornat a llegir, sense hora, només de l'organitzador i només per a una proposta; organitzador trobat per UID, l'ocurrència anomenada o la primera, i no per a un altre organitzador, una subscripció, el que és cancel·lat o un altre compte |
| N1 `calendar/overlap/tests.rs` | Sense cancel·lats, lliures, rebutjats ni subscripcions; extrems que es toquen no coincideixen; ordre; diversos comptes o un; l'esdeveniment propi exclòs per UID, id importat, id CalDAV o sèrie; dia sencer segons la zona de la persona, en tots dos sentits |
| N1 `subscription.rs` | `TRANSP:TRANSPARENT` es desa com a lliure; la resta, sense suposar res |
| N1 distribuïdor (`main.rs`) | Coincidències amb l'esdeveniment propi i sense; proposta a l'organitzador i rebutjada per a una versió antiga o una reunió cancel·lada; com a organitzador, només informació sense l'esdeveniment aquí i rebuig enviat a qui ha proposat quan hi és |
| N2 `InvitationCard.test.tsx` | Proposar: camps, validació, càrrega exacta d'`invite.counter`, adjunt `method=COUNTER` a l'organitzador, coincidències, error explicat i reintent, motiu del nucli; organitzador: rebutjar amb nota i adjunt `method=DECLINECOUNTER`, obrir l'editor amb l'hora proposada i coincidències a l'editor, desar sense preguntar si cal avisar en un calendari local; proposta antiga o d'altri sense botons; un rebuig rebut només informa |
| N3 | Es mantenen les de Radicale de l'ADR-0018; no hi ha cap prova N3 nova |
| N5 pendent | Outlook, Gmail i Apple Calendar rebent i enviant COUNTER i DECLINECOUNTER |

## Bloquejat

La disponibilitat d'altres persones des dels seus servidors queda fora d'abast:
- Google necessita els registres OAuth propis;
- Radicale no té la safata de sortida de CalDAV scheduling;
- `GetUserAvailability` d'EWS necessita un servidor real.
