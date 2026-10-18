# ADR-0019: Invitacions que arriben per correu (iMIP)

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #102.

## Context

Les invitacions d'Exchange i Google ja es contestaven des del seu calendari,
per les seves API. Una invitació rebuda en un compte IMAP apareixia com un
adjunt `.ics` i prou. #102 exigeix que el correu rebut no autoritzi mai a
contestar sol.

## Alternatives

1. **Llegir, descriure i actuar només amb un botó (escollida).** Amb «Acceptar»,
   «Potser» o «Rebutjar» es desa l'esdeveniment al calendari triat (local o
   CalDAV) o es treu, i s'envia la resposta iTIP a l'organitzador per la ruta
   normal d'enviament. Així queda registrada com a intent d'enviament (#29), amb
   còpia a Enviats.
2. **Afegir automàticament al calendari les invitacions rebudes**, com
   fa Gmail. És còmode, però omple el calendari amb el que arriba de
   qualsevol i és un vector de correu brossa conegut.
3. **Contestar des del servidor de calendari (CalDAV scheduling).** Pocs
   servidors ho implementen, i no s'aplica a calendaris locals.

## Decisió

- **Lectura:** l'analitzador reconeix una part `text/calendar` (o
  `application/ics`) amb METHOD i desa amb el missatge la seva descripció:
  mètode, UID, SEQUENCE, ocurrència, assumpte, lloc, primera hora,
  organitzador i assistents amb el seu estat, i l'objecte tal com va arribar.
- **Resposta:** es construeix segons RFC 5546 §3.2.3 (UID, SEQUENCE,
  RECURRENCE-ID si n'hi ha, ORGANIZER i només l'ATTENDEE propi amb el seu
  PARTSTAT). S'envia com a adjunt `text/calendar; method=REPLY` (RFC 6047),
  amb el mètode com a paràmetre real al Content-Type.
- **Calendari:**
  - acceptar o «potser» desa l'esdeveniment sense METHOD i amb el PARTSTAT propi;
    a CalDAV com a objecte propi i en local com les seves ocurrències;
  - rebutjar el treu;
  - una còpia amb SEQUENCE més gran no se sobreescriu.
- **Cancel·lació:** només es treu en prémer «Treure del meu calendari».
- **Versions:**
  - es desa la darrera resposta per compte i UID (`invitation_answers`,
    que se suprimeix amb el compte segons l'ADR-0011);
  - una invitació amb SEQUENCE més petit que la ja contestada apareix com a
    antiga i no ofereix botons;
  - la mateixa versió es pot tornar a contestar, que és com es reintenta.
- **Fallada d'enviament:** si el calendari s'ha actualitzat però la resposta no
  ha sortit, es diu exactament això, i tornar a prémer l'envia.
- **Exchange i Google:** la targeta ho descriu i indica que es contesti al
  calendari del compte, com abans.

## Pendent

- Contraproposar: resolt a l'ADR-0043 (COUNTER i DECLINECOUNTER).
- Reenviar una invitació.
- Disponibilitat (free/busy): les coincidències amb l'agenda pròpia es
  resolen a l'ADR-0043; la disponibilitat d'altres persones des dels
  servidors continua bloquejada (vegeu l'ADR-0043).
- Actualitzar com a organitzador l'estat dels assistents en rebre
  respostes: ara només es mostren.
- Verificació N5 amb Outlook, Gmail i Apple Calendar.
