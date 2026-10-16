# ADR-0018: Calendaris CalDAV

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: l'adaptador CalDAV de #101.

## Context

Exchange i Google ja sincronitzen calendaris; un compte IMAP no en té
cap. #101 demana CalDAV i exigeix decidir abans la identitat de les
recurrències.

## Alternatives

1. **Calendaris CalDAV com a font pròpia, llistats sota un compte
   (escollida).** Es descobreixen amb el seu propi usuari i contrasenya, com les
   llibretes CardDAV, i serveixen per a qualsevol compte: Fastmail, iCloud,
   Nextcloud o Radicale.
2. **Una ruta CalDAV deduïda del servidor de correu.** Poques vegades és el
   mateix host, i obligaria a endevinar.
3. **Expansió de recurrències al servidor** (`<C:expand>`). No tots els
   servidors la implementen, i perdríem la regla, que cal per a
   escriure.

## Decisió

- **Descobriment:** principal → `calendar-home-set` → col·leccions amb
  `resourcetype` calendar. Es reutilitza el transport de CardDAV amb les seves
  regles: la contrasenya mai no baixa d'HTTPS a HTTP, mai no surt a un altre
  origen si no és per HTTPS, i una escriptura només va al servidor del calendari
  (#28).
- **Permisos:** `current-user-privilege-set`; un calendari de només lectura
  es mostra i no s'edita.
- **Lectura:** `calendar-query` amb `time-range` de la finestra, i expansió
  aquí amb el mateix lector RFC 5545 de les subscripcions. És tot o res: si
  falta un objecte, es conserva la finestra anterior.
- **Identitat:**
  - cada ocurrència és `{UID}@{inicio original}`, com a les subscripcions;
  - es desa on viu cada UID (`caldav_objects`: href i ETag);
  - la versió de l'objecte viatja com a `change_key` de cada ocurrència.
- **Escriptura:**
  - **Esdeveniment nou:** objecte nou amb `If-None-Match: *`.
  - **Editar un esdeveniment o la sèrie:** es pren l'objecte del servidor, es
    comprova que continua en la versió que es va veure i s'envia amb `If-Match`.
    En editar la sèrie des d'una ocurrència, el canvi es trasllada com a
    desplaçament, de manera que la sèrie conserva la seva primera data.
  - **Editar una ocurrència:** component d'excepció amb
    `RECURRENCE-ID`.
  - **Suprimir una ocurrència:** `EXDATE`.
  - **Suprimir la sèrie:** `DELETE` amb `If-Match`.
  - En tots els casos es conserva línia a línia el que aquesta aplicació no
    edita: assistents, organitzador, propietats X- i zones.
- **Conflicte:** si la versió ha canviat (412 o un ETag diferent), no
  s'escriu res, es diu i es refresca el calendari (política de l'ADR-0012).
- **Zones:**
  - un esdeveniment únic s'escriu en UTC;
  - una sèrie, en la seva zona IANA (la que ja tenia, o la de l'equip), perquè
    no es mogui una hora a cada canvi d'hora; les zones equivalents a
    UTC s'escriuen en UTC pla;
  - en llegir, un `…Z` al costat d'un `TZID` és UTC, perquè Radicale (vobject)
    escriu aquesta forma.
- **Treure el calendari:** deixa de mostrar-se aquí i continua al seu servidor.
  En treure el compte se suprimeixen les seves files i les seves contrasenyes (ADR-0011).

## Conseqüències

- Proves:
  - N1 amb un servidor fals amb estat (descobriment, versions,
    conflictes, ocurrències, origen);
  - N3 contra Radicale al job (tasca de CI) d'integració: edició que conserva
    assistents, conflicte sense escriptura, sèrie amb excepció i EXDATE.
- Queda fora: cua sense connexió (les escriptures requereixen xarxa i fallen
  visiblement sense xarxa), invitacions (iMIP) i proveïdors certificats
  (N5).
