# ADR-0069: Barra lateral dreta de tota l'aplicació: agenda, dia i persona

- Estat: proposada. Cal que el propietari l'accepti abans d'escriure'n el codi.
  La decisió D8 de la proposta de redisseny demanava escriure aquesta ADR; el
  propietari va aprovar la proposta el 2026-10-17 («Lo apruebo»), abans que
  existís aquest text, i l'ADR necessita la seva pròpia acceptació. Les
  decisions D1–D9 consten a
  [#288](https://github.com/adilelhaji/oreneta/issues/288#issuecomment-6240630278).
- Data: 2026-10-17.
- Abast: #223 (fila SET-23 del registre d'acceptació, #86) i peça 12 de la
  proposta de redisseny, dins de #288. Substitueix part d'ADR-0059 (vegeu el
  §5); depèn del marc d'ADR-0068. Fora d'abast: els panells de contactes,
  adjunts, xat i invitacions del client de referència, que vindran en
  incidències pròpies, i l'aplicació mòbil.

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
  (`session_sidebar_section_main`: `overview`, `media`, `files` o `agenda`)
  es desen; si és oberta o tancada només dura la sessió (`thread$.mediaOpen`,
  la tecla `i`).
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
  | Conversa | El resum, la multimèdia i els fitxers (les subseccions actuals) | Correu i taulers, amb una conversa oberta |

- **Selector de panells** al peu, de 2,5 rem: una llista de pestanyes
  (`tablist`), amb les fletxes laterals en cercle i en el sentit de lectura, i
  totes les pestanyes a l'abast del Tab, com a ADR-0061. Sense conversa oberta,
  la pestanya Conversa no hi és (no es mostra desactivada: no tindria
  contingut).

### 2. Estats, amplada i què es desa

- **Tres estats:** desplegada (amb amplada), minimitzada (una tira de 2,5 rem,
  40 px al 100 %, amb la icona de cada panell; una icona desplega la barra en
  aquell panell) i amagada (res; s'obre des de la barra d'eines o el menú). Es
  desa a la preferència nova `app_sidebar_state` (`expanded`, `minimized`,
  `hidden`).
- **Què canvia l'estat desat:** el botó «Barra lateral» de la barra d'eines,
  les icones de la tira, el botó de minimitzar de la barra i la tecla `i`. Tancar
  la capa (Esc, un clic al fons) no el canvia: la capa és una manera de
  mostrar-la quan no hi cap, no una preferència.
- **En arrencar no s'obre mai una capa sola:** si l'estat desat és `expanded`
  però la barra no hi cap al costat, es pinta minimitzada (per sota de 769 px,
  amagada) i l'estat desat no canvia.
- **Amplada:** la mateixa preferència i els mateixos límits d'avui
  (`details_panel_width`, 280–560 px), amb el `PaneResizer` d'ADR-0059.
- **Panell recordat:** `session_sidebar_section_main` desa el tipus de panell,
  mai la persona. Valors nous: `day` i `person`. En llegir-lo:

  | Valor desat | Amb una conversa oberta | Sense conversa oberta |
  |---|---|---|
  | `overview`, `media`, `files` | Conversa, en aquella subsecció | Agenda |
  | `agenda`, `day`, `person` | Aquell panell | Aquell panell |
  | desconegut o buit | Agenda | Agenda |

- **Al costat o a sobre** (la regla d'ADR-0059, ara amb la fila del marc a tots
  els mòduls): la barra va al costat si la finestra fa almenys 1100 px i

  `resta = fila − carpetes (mín. 200) − llista (mín. 280, només al correu) − contingut (mín. 360) ≥ 280`,

  on la fila és l'amplada dibuixada sense la barra lateral i les carpetes
  compten només si són visibles. Al costat, el màxim és `min(560, resta)`. Per
  fer-hi lloc, cedeixen primer les carpetes fins al seu mínim i després la
  llista; si encara no hi cap, és una capa sobre el contingut (com a màxim el
  85 % de la finestra, amb fons). La tira minimitzada sempre va al costat.
- **Comptes al correu** (carpetes, llista i lector als mínims): a 1100 px,
  1100 − 200 − 280 − 360 = 260 < 280, i és una capa; a 1180 px, la resta és
  340 i va al costat fins a 340 px; a 1440 px, 600, i va al costat fins a 560
  px. Als altres mòduls, sense llista, a 1100 px la resta és 540. Per tant, al
  correu el llindar real passa de 1100 a 1120 px, i les proves de #212 a 1100 px
  amb 560 px desats passen d'esperar la barra al costat a esperar-la com a capa.
- **Per sota de 769 px** no hi ha tira: la barra només s'obre com a capa des de
  la barra d'eines o el menú, i en tancar-se torna a quedar amagada.
- **Obrir i tancar:** el botó «Barra lateral» de la barra d'eines de cada mòdul
  (`aria-expanded`), una ordre a la paleta i al menú de l'aplicació, i la tecla
  `i` (`thread.details`) al correu: si la barra és desplegada al panell
  Conversa, la minimitza; si no, la desplega al panell Conversa.

### 3. Panell Dia (nou)

- **Què mostra:** els esdeveniments d'un dia dels calendaris activats de tots
  els comptes, amb la mateixa lectura que l'agenda: `calendar.events` des de la
  memòria cau, actualització en segon pla, relectura amb `calendar.synced`, a
  mitjanit i en canviar de dia. Els de tot el dia, a dalt, per les seves dates
  (`allDayLocalDays`); després, per hora d'inici. Avui, l'hora actual és una
  línia.
- **Cancel·lats:** no es mostren, com a l'agenda. Quan #282 (peça 5) doni als
  cancel·lats un estat propi a la graella del calendari, el panell el seguirà en
  la mateixa peça.
- **Navegació:** dia anterior, dia següent i «Avui». A Calendari, el dia del
  panell és, en obrir-lo, el dia seleccionat a la visualització principal; no
  el segueix després, per no moure's mentre es mira.
- **El que no es pot llegir es diu:** un calendari que no es llegeix dona
  l'avís «pot estar incompleta» d'ADR-0059 i un `calendar.syncError`, l'avís de
  dades desactualitzades fins que un `calendar.synced` d'aquest compte cobreixi
  el dia. Un dia sense esdeveniments mostra «Cap esdeveniment» només si totes
  les lectures han anat bé.
- **Obrir:** un esdeveniment obre el calendari en aquell dia amb la fitxa
  oberta (`openCalendarOn`, com l'agenda).
- **Teclat:** cada esdeveniment és un botó natiu amb el nom complet (títol,
  hora, calendari i estat), com a la graella del calendari.

### 4. Panell Persona

- **Qui és la persona en context:**
  - al correu, amb una conversa oberta: si hi ha una sola persona que no és
    un compte propi, aquesta; si n'hi ha diverses, la llista de participants
    de la conversa per triar-ne una;
  - a Persones: el contacte seleccionat;
  - en els altres mòduls, o sense selecció: un estat buit que diu què s'ha de
    seleccionar. No s'endevina ningú.
- **Compte (aïllament de #86):** al correu, el de la conversa, com avui. A
  Persones, el compte de la llibreta del contacte (`contact_sources.account`);
  una llibreta que no és de cap compte (local, o CardDAV sense compte) fa que
  el panell demani triar un compte. No barreja comptes ni en tria un tot sol.
- El contingut i les regles (adreça exacta, cobertura indicada, resposta tardana
  d'un altre compte descartada) són els de #86.

### 5. Relació amb ADR-0059

- **Se substitueixen:**
  - «On és l'agenda»: ja no és una secció de la barra de detalls d'una
    conversa, sinó un panell de la barra de l'aplicació, sense conversa oberta i
    a tots els mòduls. Això inverteix l'alternativa que ADR-0059 va descartar,
    «Agenda visible en totes les visualitzacions»;
  - «Secció recordada»: s'amplien els valors i l'historial d'una persona passa
    a ser un panell (§2 i §4);
  - el punt de «Redimensionar» que diu quan la barra lateral va al costat del
    lector, que ara mesura la fila del marc a tots els mòduls (§2); els límits
    no canvien;
  - «Capa sobre la capçalera»: la capa queda per sobre de la capçalera del
    mòdul, a tots els mòduls.
- **Es mantenen:** el contingut, l'ordre, la lectura i les relectures de
  l'agenda; obrir esdeveniments i tasques; el teclat; el separador i els seus
  límits; les preferències `details_panel_width`, `thread_list_width` i
  `kanban_pane_width`.
- A ADR-0059 s'afegeix a l'estat una línia que remet a aquesta ADR (proposada).

### 6. Proves

- **Unitat:** `lib/paneResize.test.ts` (la fórmula del §2 a 1100, 1120, 1180 i
  1440 px, amb carpetes i sense, al correu i als altres mòduls; tira
  minimitzada; menys de 769 px); un `lib/dayPanel.test.ts` nou (dia, tot el dia
  en UTC, São Paulo i Sydney, cancel·lats, línia de l'hora);
  `states/settings` i `states/ui` (`app_sidebar_state`, la taula de conversió
  de la secció, valors no vàlids).
- **Components:** la barra a cada mòdul; què canvia l'estat desat i què no
  (Esc i el fons de la capa no); l'arrencada amb `expanded` en una finestra
  estreta; el selector de panells amb el teclat i en àrab; el panell Dia (lectura
  parcial, avís de dades desactualitzades, «Cap esdeveniment» només amb lectures
  correctes, obrir l'esdeveniment); el panell Persona (una persona, diverses,
  Persones amb llibreta de compte i sense, estat buit).
- **Entrada de producció:** a 600, 1024, 1100, 1180 i 1440 px, en clar i en
  fosc, en català i en àrab, al 200 % de l'aplicació a 1440 i 1024 px i a
  l'equivalent de zoom del sistema (720 px CSS a escala 2): l'agenda s'obre
  sense conversa en arrencar i des de Calendari, Tasques, Persones i Notes;
  l'estat i l'amplada es recuperen després de reiniciar; auditoria axe de la
  barra. Les proves de #212 es mantenen, amb el canvi de 1100 px del §2.

## Alternatives descartades

- **Dues barres (la de detalls de la conversa i una de l'aplicació):** dues
  columnes que competeixen pel mateix costat i el mateix espai a 1100–1440 px.
- **Una subfinestra de ginys a la dreta només a Calendari, Tasques i Persones:**
  no resol l'arrencada sense conversa, que és el que demana SET-23.
- **Que el panell Dia segueixi sempre el dia del calendari:** el panell es
  mouria sol mentre es fa servir.
- **Triar un compte per a l'historial quan la llibreta no en té** (el primer,
  o barrejar-los): contradiu l'aïllament de #86 i mostraria un historial que
  pot no ser el que es busca.
- **Desar l'estat obert o tancat només durant la sessió, com avui:** amb la
  barra a tots els mòduls, caldria tornar-la a obrir a cada arrencada, i
  l'agenda tornaria a no ser visible en arrencar, que és la mancança de SET-23.
- **Desar també el tancament de la capa:** una interacció en una finestra
  estreta canviaria la preferència de la finestra ampla.

## Conseqüències

- Aquesta ADR no canvia el nucli: fa servir `calendar.events`, `tasks.list` i
  `context.person`. Canvis de preferències: `app_sidebar_state` (nova) i els
  valors nous de `session_sidebar_section_main`. Que l'agenda digui «pot estar
  incompleta» mentre una llista de tasques d'un compte no s'ha llegit ve
  d'ADR-0070, que sí que canvia `tasks.lists`.
- `ConversationDetailsPanel` passa a ser el contingut del panell Conversa i
  deixa de ser el contenidor; `MessagePane` ja no el mostra.
- Cadenes noves («Barra lateral», «Dia», «Persona», els estats buits) en català
  primer i a tots els catàlegs.
- **Documents que s'actualitzen amb la peça:** contextual-sidebar.md (el
  «Límit» de l'agenda) i ADR-0059 (la línia d'estat).
- **Registre d'acceptació:** amb les proves automàtiques, SET-23 pot passar de
  `partial` a `implemented-unverified`; no a `verified` sense l'evidència
  nativa (N4). Les evidències automàtiques de la fila que canvien
  (`ConversationDetailsPanel.test.tsx`, `paneResize.test.ts`, `startup.e2e.ts`)
  es tornen a registrar amb el resum (hash) nou.

## Decisions que ha de prendre el propietari

1. **Estat per defecte** en un perfil nou i en actualitzar: minimitzada
   (recomanat: no pren espai sense demanar-ho) o desplegada (com el client de
   referència).
2. **Panell Conversa** dins de la barra de l'aplicació (recomanat) o la barra
   de detalls d'avui a part.
3. **Panell Dia a Calendari:** pren el dia seleccionat en obrir-se (recomanat)
   o el segueix sempre.
4. **Historial a Persones:** el compte de la llibreta del contacte, i demanar-lo
   quan la llibreta no en té (recomanat), o no oferir el panell a Persones.
5. **Amplada mínima del contingut** als mòduls que no són correu: 360 px com
   el lector (recomanat) fins que la seva peça en fixi una altra.
6. **Llindar al correu:** acceptar que, amb les carpetes visibles, la barra va
   al costat a partir de 1120 px i no de 1100 (recomanat), o amagar les carpetes
   quan la barra es desplega entre 1100 i 1120 px.
