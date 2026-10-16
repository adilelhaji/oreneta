# Calendaris CalDAV (#101, ADR-0018)

## Ús

**Afegeix un calendari → Servidor CalDAV**:
1. S'escriuen el servidor (o l'adreça), l'usuari i la contrasenya.
2. **Cerca calendaris** llista els que hi ha. Els de només lectura apareixen
   sense marcar.
3. **Afegeix** els desa sota el compte triat.

Es llegeixen i s'editen com els altres calendaris. Si algú ha canviat un
esdeveniment en un altre dispositiu, en desar no s'escriu res: s'avisa i
s'actualitza. Treure'l d'aquí no el suprimeix del servidor.

## Fitxers .ics

A la configuració de cada calendari, **Fitxers de calendari**:
- **Importa un .ics…** és als calendaris locals i als CalDAV amb escriptura.
  Primer indica quants esdeveniments s'afegiran, quants es repeteixen i quants
  ja hi són, i no afegeix res dues vegades.
  - A CalDAV, cada sèrie viatja amb la seva regla, les seves excepcions i les
    seves zones com un objecte propi.
  - En un calendari local, una sèrie es converteix en les seves ocurrències
    dels pròxims 5 anys (com a màxim 512).
- **Exporta un .ics…** escriu les ocurrències que el calendari té aquí, encara
  que estigui ocult, en un fitxer que es reanomena en acabar.

## Defectes trobats en provar

- **Radicale** reescriu `DTSTART;TZID=Etc/UTC:…` com a `…Z` al costat del
  `TZID`, i el lector descartava tota la sèrie. Ara una `Z` preval sobre el
  `TZID`, i les zones UTC s'escriuen en UTC pla.
- **Crides al nucli:**
  - el descobriment CardDAV heretava el límit de 5 s, i ara té 60 s com
    CalDAV;
  - la finestra de treure deia «van a Elements suprimits del servidor» també
    per als calendaris locals, subscrits i CalDAV;
  - la regla «un compte conserva com a mínim un calendari» impedia treure
    l'únic calendari local, subscrit o CalDAV llistat sota un compte.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `calendar/ics/tests.rs` | Seqüències d'escapament i plegament; anada i tornada d'un esdeveniment; dia sencer; sèrie que manté l'hora local després del canvi d'hora; edició que conserva assistents, organitzador, X- i substitueix l'alarma; desplaçament de sèrie que conserva la primera data; excepció, segona excepció que reemplaça i EXDATE; recordatoris; exportació; UTC pla; `Z` amb `TZID` |
| N1 `calendar/caldav/tests.rs` | Descobriment pel principal amb permisos i colors; crear, llegir la versió, conflicte sense escriptura i edició des de la versió actual; ocurrències canviades i suprimides; finestra incompleta rebutjada; res enviat a un altre servidor |
| N1 protecció ADR-0011 | `caldav_objects` se suprimeix amb el compte; les contrasenyes també |
| N3 `integration_caldav_test.go` (Radicale) | Descobrir i afegir; edició que conserva assistents i línies d'altri; conflicte sense escriptura; sèrie amb una ocurrència canviada i una altra suprimida |
| N1 `calendar/import/tests.rs` i distribuïdor | Divisió per UID amb excepcions i zones; UID estable per als components que no en tenen; calendari local amb esdeveniments solts i sèrie acotada; previsualització sense desar; segona importació sense duplicats; exportació reanomenada en acabar; calendari inexistent rebutjat |
| N3 Radicale | Importar a CalDAV conserva la regla, i la segona vegada no afegeix res |
| N2 `CalDavCalendars.test.tsx` (importar) | Confirmació amb el resum abans d'importar; només en calendaris locals i CalDAV amb escriptura |
| N2 `CalDavCalendars.test.tsx` | Cercar i triar calendaris (els de només lectura sense marcar); error del servidor visible; textos de treure i regla de l'últim calendari |

## Invitacions per correu (#102, ADR-0019)

Un missatge que porta una invitació mostra una targeta amb l'assumpte, l'hora,
el lloc i l'organitzador.
- **Invitació:** es tria on desar-la (un calendari local o CalDAV, o cap) i es
  respon «Accepta», «Potser» o «Rebutja». La targeta avisa que respondre envia
  un missatge a l'organitzador.
- **Cancel·lació:** la targeta ofereix «Treu-lo del meu calendari».
- **Resposta rebuda:** indica qui ha acceptat o rebutjat.

Res d'això no passa sense prémer-ho.

| Nivell | Què cobreix |
|---|---|
| N1 `calendar/itip/tests.rs` (fixtures segons l'RFC 5546) | Lectura amb zona, sèrie, organitzador i assistents; un calendari publicat no és una invitació; resposta amb només l'assistent propi, SEQUENCE i RECURRENCE-ID; una cancel·lació no es respon; esdeveniment desat sense METHOD i amb PARTSTAT; versions; una resposta antiga no desfà una de nova |
| N1 `parse.rs` | Un missatge multipart amb `text/calendar` porta la invitació; un que no en té, no |
| N1 `smtp.rs` | La resposta surt amb `method=REPLY` com a paràmetre del Content-Type |
| N1 distribuïdor | Acceptar desa al calendari local i prepara la resposta a l'organitzador; estat; una versió antiga no envia res; només una cancel·lació treu l'esdeveniment, i el treu |
| N2 `InvitationCard.test.tsx` | No es respon res sense prémer; resposta amb l'adjunt `text/calendar; method=REPLY` a l'organitzador; «Cap calendari»; error d'enviament explicat; a Exchange es respon al seu calendari; versió antiga sense botons; treure una cancel·lació |
