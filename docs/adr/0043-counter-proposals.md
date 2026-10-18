# ADR-0043: Proposar una altra hora i coincidències amb l'agenda pròpia

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: el que ADR-0019 va deixar pendent de #102 (contraproposta i
  disponibilitat).

## Decisió

- **Proposar una altra hora (assistent):**
  - a la targeta d'una invitació per correu, «Proposar una altra hora» obre un
    formulari amb inici, fi i una nota opcional; no surt res fins que es prem
    «Enviar proposta»;
  - s'envia un iTIP `COUNTER` (RFC 5546 §3.2.7) només a l'organitzador, per la
    mateixa ruta que les respostes (ADR-0019): un missatge normal amb adjunt
    `text/calendar; method=COUNTER`, registrat com a intent d'enviament;
  - l'objecte porta el mateix UID i la mateixa SEQUENCE de la invitació (una
    proposta no crea versió), DTSTAMP, l'ORGANIZER tal com va arribar, només
    l'ATTENDEE propi, l'inici i la fi proposats (en UTC, o com a
    `VALUE=DATE` si la invitació és de dia sencer), el SUMMARY i el COMMENT
    escapat;
  - es rebutja, sense enviar res, si la invitació és antiga (SEQUENCE menor
    que la ja contestada), si la reunió està cancel·lada (CANCEL, STATUS o
    cancel·lació aplicada), si la fi no és posterior a l'inici, si el compte
    és l'organitzador o si és una sèrie sencera sense RECURRENCE-ID;
  - el calendari propi no canvia: decideix l'organitzador.
- **Rebre una proposta (organitzador):**
  - la targeta diu qui proposa quina hora i la seva nota;
  - si el compte organitza un esdeveniment desat aquí amb aquest UID (calendari
    propi, no subscripció, amb ORGANIZER igual al compte), ofereix
    «Obrir a l'editor» i «Rebutjar la proposta»; si no, només informa;
  - una proposta per a una versió anterior apareix com a antiga i sense
    botons. La SEQUENCE actual es llegeix del servidor si l'esdeveniment és a
    CalDAV. En un calendari local no es desa i no es pot comparar.
- **Acceptar una proposta:** «Obrir a l'editor» obre l'esdeveniment propi amb
  l'hora proposada. Desar passa per l'actualització de sempre
  (`calendar.update`) i no hi ha cap ruta nova d'enviament.
  - En calendaris locals i CalDAV, desar no avisa els assistents; la
    targeta i l'editor ho diuen.
  - L'editor ja no pregunta «Avisar els assistents?» en aquests
    calendaris: abans ho preguntava i el nucli no enviava res.
- **Rebutjar una proposta:** iTIP `DECLINECOUNTER` (§3.2.8) només a
  l'assistent que va proposar, amb el mateix UID i SEQUENCE, l'ORGANIZER, aquest
  ATTENDEE, DTSTAMP i la nota opcional. La reunió queda com estava.
- **Rebuig rebut (assistent):** la targeta diu «L'organitzador ha rebutjat
  l'hora que vas proposar», amb la seva nota, i res més.
- **Coincidències amb l'agenda pròpia:**
  - l'editor d'esdeveniments, la targeta d'una invitació, el formulari de
    proposta i la targeta d'una proposta diuen quins esdeveniments propis es
    superposen amb aquesta hora: «Coincideix amb: …», fins a tres assumptes i
    «i N més»;
  - és una consulta local a `calendar_events` de tots els comptes, sense
    xarxa, i no compta el que s'ha cancel·lat, el que és lliure o transparent
    (`free_busy` `free`), el que la persona ha rebutjat ni el mateix
    esdeveniment;
  - tampoc no compten les subscripcions: són calendaris publicats per
    altres, com els festius;
  - un esdeveniment de dia sencer només compta si l'hora proposada toca el seu
    dia allà on és la persona;
  - un esdeveniment CalDAV o importat amb `TRANSP:TRANSPARENT` ara es desa
    com a lliure.
- **Exchange i Google:** els seus comptes tracten les propostes al seu propi
  calendari; la targeta ho indica, com amb les invitacions.

## Alternatives descartades

- **Aplicar la proposta al calendari directament des de la targeta:**
  canviaria l'hora sense revisar la resta de l'esdeveniment. A més, semblaria
  que els assistents queden avisats, i no és així.
- **Enviar des d'aquí l'actualització a tots els assistents en acceptar:**
  no existeix cap ruta d'enviament d'actualitzacions de l'organitzador per a
  calendaris locals i CalDAV, i no se n'inventa cap en aquest lliurament.
- **Desar la SEQUENCE a `calendar_events`:** seria una columna més per
  sincronitzar en tots els proveïdors. N'hi ha prou de llegir-la del servidor
  CalDAV quan cal.
- **Disponibilitat dels assistents des dels servidors:** bloquejada.
  - Google necessita els registres OAuth propis.
  - La safata de sortida de CalDAV scheduling no existeix a Radicale, que és
    el servidor de proves.
  - `GetUserAvailability` d'EWS necessita un servidor Exchange real.

## Pendent

- Avisar els assistents en desar com a organitzador en calendaris
  locals i CalDAV (enviar un REQUEST actualitzat).
- Disponibilitat d'altres persones des de Google, CalDAV i EWS (bloquejada,
  vegeu més amunt).
- Verificació N5 amb Outlook, Gmail i Apple Calendar.
