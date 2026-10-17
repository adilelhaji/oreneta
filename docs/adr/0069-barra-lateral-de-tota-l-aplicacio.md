# ADR-0069: Barra lateral dreta de tota l'aplicació: agenda, dia i persona

- Estat: proposada. Cal que el propietari l'accepti abans d'escriure'n el codi
  (decisió D8 de la proposta de redisseny, aprovada el 2026-10-17 amb «Lo
  apruebo»: aquesta ADR és nova i necessita la seva pròpia aprovació).
- Data: 2026-10-17.
- Abast: #223 (fila SET-23 del registre d'acceptació, #86) i peça 12 de la
  proposta de redisseny, dins de #288. Substitueix part d'ADR-0059 (vegeu
  «Relació amb ADR-0059»); depèn del marc d'ADR-0068. Fora d'abast: els panells
  de contactes, adjunts, xat i invitacions del client de referència, que
  vindran en incidències pròpies, i l'aplicació mòbil.

## Context

- La barra lateral de detalls (`ConversationDetailsPanel.tsx`) només existeix
  amb una conversa oberta al lector. Hi ha el resum (participants), la
  multimèdia, els fitxers i, des d'ADR-0059 (#212), l'agenda (`SidebarAgenda`,
  set dies d'esdeveniments i tasques amb data). L'historial d'una persona
  (#86, `PersonHistory`, RPC `context.person`) s'obre des d'un participant,
  només amb el compte de la conversa.
- Es mostra al costat del lector amb una finestra de 1100 px o més i espai per
  a 280 px més 360 px de lector; si no, és una capa sobre el lector. L'amplada
  (`details_panel_width`, 280–560 px) i l'última secció
  (`session_sidebar_section_main`) es desen; si és oberta o tancada només dura
  la sessió (`thread$.mediaOpen`, la tecla `i`).
- La fila SET-23 continua `partial` perquè a l'agenda no s'hi arriba sense
  conversa oberta ni des de Calendari, Tasques, Persones o Notes. El client de
  referència té la barra lateral als mòduls de correu, calendari, contactes i
  tasques, sense dependre del missatge seleccionat.

## Decisió

### 1. On és

- **Una sola barra lateral, de l'aplicació:** l'`<aside>` del final de la fila
  del marc (ADR-0068, §1), després de `<main>`, a tots els mòduls. Nom
  accessible: «Barra lateral». Substitueix la barra de detalls com a
  contenidor: no n'hi ha dues.
- **Panells:**

  | Panell | Contingut | On n'hi ha |
  |---|---|---|
  | Agenda | El d'ADR-0059 sense canvis: set dies, vençudes primer | Tots els mòduls |
  | Dia | Nou: un dia de calendari (§3) | Tots els mòduls |
  | Persona | L'historial de #86 de la persona en context (§4) | Tots els mòduls; amb un estat buit on no n'hi ha cap |
  | Conversa | El resum, la multimèdia i els fitxers d'avui | Correu i taulers, amb una conversa oberta |

- **Selector de panells** al peu, de 2,5 rem: una llista de pestanyes
  (`tablist`), amb les fletxes laterals en el sentit de lectura i totes les
  pestanyes a l'abast del Tab, com a ADR-0061. Sense conversa oberta, la
  pestanya Conversa no hi és (no es mostra desactivada: no hi ha res a dir).

### 2. Estats, amplada i què es desa

- **Tres estats:** desplegada (amb amplada), minimitzada (una tira de 40 px amb
  la icona de cada panell; una icona desplega la barra en aquell panell) i
  amagada (res; s'obre des de la barra d'eines o el menú). Es desa a la
  preferència nova `app_sidebar_state` (`expanded`, `minimized`, `hidden`).
- **Amplada:** la mateixa preferència i els mateixos límits d'avui
  (`details_panel_width`, 280–560 px), amb el `PaneResizer` d'ADR-0059.
- **Panell recordat:** `session_sidebar_section_main` admet els valors nous
  `day` i `person`. Un valor desconegut o `conversation` sense conversa oberta
  obre l'agenda. La persona no es desa: el panell segueix la selecció.
- **Al costat o a sobre** (la regla d'ADR-0059, ara per a tots els mòduls): al
  costat del contingut si la finestra fa almenys 1100 px i la fila deixa al
  contingut del mòdul la seva amplada mínima (360 px al lector del correu; la
  mateixa xifra als altres mòduls fins que una peça en fixi una altra); si no,
  és una capa sobre el contingut (com a màxim el 85 % de la finestra, amb
  fons), que Esc i el fons tanquen fins a l'estat minimitzat. La tira
  minimitzada sempre va al costat.
- **Per sota de 769 px** no hi ha tira: la barra només s'obre com a capa des
  de la barra d'eines o el menú, i en tancar-se torna a amagada.
- **Obrir i tancar:** un botó «Barra lateral» a la barra d'eines de cada mòdul
  (`aria-expanded`), una ordre a la paleta i al menú de l'aplicació, i la tecla
  `i` (`thread.details`) al correu, que ara obre o tanca la barra al panell
  Conversa, com feia amb la de detalls.

### 3. Panell Dia (nou)

- **Què mostra:** els esdeveniments d'un dia dels calendaris activats de tots
  els comptes, amb la mateixa lectura que l'agenda: `calendar.events` des de la
  memòria cau, actualització per darrere, relectura amb `calendar.synced`, a
  mitjanit i en canviar de dia. Els de tot el dia, a dalt, per les seves dates
  (`allDayLocalDays`); després, per hora d'inici. No es mostren els cancel·lats.
  Avui, l'hora actual és una línia.
- **Navegació:** dia anterior, dia següent i «Avui». A Calendari, el dia del
  panell és, en obrir-lo, el dia seleccionat a la visualització principal; no
  la segueix després, per no moure's mentre es mira.
- **El que no es pot llegir es diu:** un calendari que no es llegeix dona
  l'avís «pot estar incompleta» d'ADR-0059 i un `calendar.syncError`, l'avís de
  dades desactualitzades fins que un `calendar.synced` d'aquest compte cobreix el
  dia. Un dia sense esdeveniments mostra «Cap esdeveniment» només si totes les
  lectures han anat bé.
- **Obrir:** un esdeveniment obre el calendari en aquell dia amb la fitxa
  oberta (`openCalendarOn`, com l'agenda).
- **Teclat:** cada esdeveniment és un botó natiu amb el nom complet (títol,
  hora, calendari i estat), com a la graella del calendari.

### 4. Panell Persona

- **Qui és la persona en context:**
  - al correu, amb una conversa oberta: si hi ha una sola persona que no és
    un compte propi, aquesta; si n'hi ha diverses, la llista de participants
    d'avui per triar-ne una;
  - a Persones: el contacte seleccionat;
  - en els altres mòduls, o sense selecció: un estat buit que diu què s'ha de
    seleccionar. No s'endevina ningú.
- **Compte (aïllament de #86):** al correu, el de la conversa, com avui. A
  Persones, el compte de correu seleccionat; amb la safata unificada no hi ha
  un compte, i el panell demana triar-ne un (no barreja comptes ni en tria un
  pel seu compte).
- El contingut i les regles (adreça exacta, cobertura indicada, resposta tardana
  d'un altre compte descartada) són els de #86.

### 5. Relació amb ADR-0059

- **Se substitueix:**
  - «On és l'agenda»: ja no és una secció de la barra de detalls d'una
    conversa, sinó un panell de la barra de l'aplicació, sense conversa oberta i
    a tots els mòduls;
  - «Secció recordada»: s'amplien els valors i l'historial d'una persona passa
    a ser un panell (§2, §4);
  - la regla de «al costat o a sobre», que ara mesura la fila del marc a tots
    els mòduls (§2); els límits no canvien;
  - «Capa sobre la capçalera»: la capa queda per sobre de la capçalera del
    mòdul, a tots els mòduls.
- **Es manté:** el contingut, l'ordre, la lectura i les relectures de l'agenda;
  obrir esdeveniments i tasques; el teclat; el separador i els seus límits; les
  preferències `details_panel_width`, `thread_list_width` i `kanban_pane_width`.
- A ADR-0059 s'hi afegeix una línia a l'estat que remet a aquesta ADR, com a
  proposada.

### 6. Proves

- **Unitat:** `lib/paneResize.test.ts` (al costat o a sobre en cada mòdul, tira
  minimitzada, menys de 769 px); un `lib/dayPanel.test.ts` nou (dia, tot el dia
  en UTC, São Paulo i Sydney, cancel·lats, línia de l'hora); `states/settings`
  (`app_sidebar_state` i valors nous de la secció, ajustats si no són vàlids).
- **Components:** la barra a cada mòdul; el selector de panells amb el teclat i
  en àrab; el panell Dia (lectura parcial, avís de dades desactualitzades, «Cap
  esdeveniment» només amb lectures correctes, obrir l'esdeveniment); el panell
  Persona (una persona, diverses, Persones, safata unificada, estat buit).
- **Entrada de producció:** a 600, 1024, 1100, 1180 i 1440 px, en clar i en fosc,
  en català i en àrab, al 200 % i a l'equivalent de zoom del 200 % (720 px CSS
  a escala 2): l'agenda s'obre sense conversa en arrencar i des de Calendari,
  Tasques, Persones i Notes; l'estat i l'amplada es recuperen després de
  reiniciar; auditoria axe de la barra. Les proves de #212 (límits amb 560 px
  desats, Retorn sobre una tasca) es mantenen.

## Alternatives descartades

- **Dues barres (la de detalls de la conversa i una de l'aplicació):** dues
  columnes que competeixen pel mateix costat i el mateix espai a 1100–1440 px.
- **Una subfinestra de ginys a la dreta només a Calendari, Tasques i Persones:**
  no resol l'arrencada sense conversa, que és el que demana SET-23.
- **Que el panell Dia segueixi sempre el dia del calendari:** el panell es
  mouria sol mentre es fa servir.
- **Triar un compte per a l'historial a la safata unificada** (el primer, o
  barrejar-los): contradiu l'aïllament de #86 i mostraria un historial que pot
  no ser el que es busca.
- **Desar l'estat obert o tancat només durant la sessió, com avui:** amb la
  barra a tots els mòduls, caldria tornar-la a obrir a cada arrencada, i
  l'agenda tornaria a no ser visible en arrencar, que és la mancança de SET-23.

## Conseqüències

- Cap canvi al nucli: es fan servir `calendar.events`, `tasks.list` i
  `context.person`. Dues preferències de la interfície: `app_sidebar_state` i
  els valors nous de `session_sidebar_section_main`.
- `ConversationDetailsPanel` passa a ser el contingut del panell Conversa i
  deixa de ser el contenidor; `MessagePane` ja no el pinta.
- Cadenes noves (Barra lateral, Dia, Persona, estats buits) en català primer i
  a tots els catàlegs.
- Registre d'acceptació: amb les proves automàtiques, SET-23 pot passar de
  `partial` a `implemented-unverified`; no a `verified` sense l'evidència
  nativa (N4).

## Decisions que ha de prendre el propietari

1. **Estat per defecte** en un perfil nou i en actualitzar: minimitzada
   (recomanat: no pren espai sense demanar-ho) o desplegada (com el client de
   referència).
2. **Panell Conversa** dins de la barra de l'aplicació (recomanat) o la barra
   de detalls d'avui a part.
3. **Panell Dia a Calendari:** pren el dia seleccionat en obrir-se (recomanat)
   o el segueix sempre.
4. **Historial a Persones amb la safata unificada:** demanar el compte
   (recomanat) o no oferir el panell.
5. **Amplada mínima del contingut** als mòduls que no són correu: 360 px com
   el lector (recomanat) fins que la seva peça en fixi una altra.
