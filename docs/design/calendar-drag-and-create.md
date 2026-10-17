# Calendari: arrossegar, deixar anar i crear des de la graella (#266, #267)

Paritat amb eM Client 10.4 (fila SET-18, incidència mare #100). Abans d'aquest
canvi, un esdeveniment només es podia moure o allargar obrint l'editor, i només
es podia crear fent doble clic en una hora o en un dia del mes. La comprovació
de l'estat de partida és a les incidències #266 i #267.

## Què es pot fer

A les visualitzacions de dia, de setmana laboral i de setmana
(`frontend/src/components/calendar/WeekView.tsx`):

| Acció | Ratolí | Teclat |
|---|---|---|
| Moure un esdeveniment | Arrossegar-lo; Esc ho cancel·la | Alt+fletxes (amunt/avall: un pas de la graella; esquerra/dreta: un dia, en l'ordre de lectura); Retorn desa i Esc cancel·la |
| Canviar l'inici o el final | Arrossegar la vora superior o inferior | Alt+Maj+fletxes amunt/avall canvien el final |
| Moure'l a un altre dia | Deixar-lo anar en un dia del calendari mensual petit, o en una altra cel·la de la franja de tot el dia | Alt+fletxa esquerra o dreta |
| Crear un esdeveniment | Arrossegar per una franja buida d'una columna; doble clic en una hora (com abans) | Franja horària que pot rebre el focus: fletxes per triar l'hora i el dia, Maj+fletxes per a la durada, Retorn |
| Crear-ne un de tot el dia | Menú contextual d'una franja buida: «Esdeveniment nou de tot el dia» | Maj+Retorn a la franja horària |
| Menú d'una franja | Clic amb el botó dret: «Esdeveniment nou» i «Esdeveniment nou de tot el dia» | Tecla de menú contextual (o Maj+F10) a la franja horària |

El calendari mensual petit (`MiniCalendar.tsx`) és nou: no n'hi havia cap a
l'escriptori. És a la columna lateral, damunt de la llista de calendaris, i
només es mostra a partir de 769 px d'amplada. Un clic en un dia obre aquell dia a
la visualització activa (des de l'agenda, a la de dia); els botons «Mes anterior»
i «Mes següent» en canvien el mes sense moure el calendari.

## Decisions

- **Pas de la graella: 15 minuts** (`SNAP_MINUTES`, `lib/calendarDrag.ts`).
  Oreneta no té cap opció d'escala de temps; un moviment acaba a la línia de
  quart d'hora més propera. Si el punter s'ha mogut menys de mig pas, no canvia
  res: un esdeveniment a les 14:37 no es mou per un toc. Un canvi de mida mai no
  el deixa més curt d'un pas.
- **Rellotge de paret.** Les posicions es llegeixen com es dibuixa la graella
  (`lib/calendarGrid`): les 10:00 són la fila de les 10:00 encara que el dia
  tingui 23 o 25 hores. Un moviment conserva la durada en temps transcorregut;
  canviar un esdeveniment de dia conserva l'hora del rellotge. Un esdeveniment de tot el dia es
  mou per dates senceres (mitjanit UTC, final exclusiu).
- **On cau es calcula des del punter**, llegit respecte de la columna que hi ha sota
  tal com és ara a la pantalla, i no des de la distància recorreguda: la graella
  es desplaça sota un esdeveniment agafat. S'usa `@dnd-kit` com al tauler kanban
  i a la navegació lateral (`CalendarDnd.tsx`); cap dependència nova. La creació
  per franja és una selecció, no un arrossegament d'un element, i usa
  esdeveniments de punter normals.
- **Res no arriba al servidor abans de deixar-lo anar o de prémer Retorn.**
  Mentre s'ajusta, l'esdeveniment queda on era (atenuat) i es dibuixa on cauria;
  una línia d'estat ho diu, i en el moviment amb teclat és una regió viva per al
  lector de pantalla. Un clic del punter en qualsevol lloc cancel·la un
  moviment amb teclat.
- **Calendaris que no es poden canviar.** Un calendari només de lectura o una
  subscripció rebutja el moviment abans de començar, amb el motiu i el nom del
  calendari. Un calendari que encara no s'ha carregat també el rebutja: no es dona
  per fet que s'hi pugui escriure.
- **Sèries.** Una ocurrència d'una sèrie pregunta «Només aquest
  esdeveniment» o «Tota la sèrie», amb el mateix diàleg i les mateixes regles
  que l'editor. Què fa «Tota la sèrie» ho decideix el nucli per a cada
  proveïdor, sense canvis: a Google la sèrie conserva les seves dates i pren la
  nova hora i la nova durada; a CalDAV es desplaça tota la sèrie la mateixa
  diferència; a Exchange s'escriu a l'element mestre de la sèrie. Si l'esdeveniment té
  convidats i se'ls pot avisar, es pregunta si se'ls diu, com a l'editor.
- **Conflictes.** El moviment s'escriu amb `calendar.update` i la clau de
  versió (`change_key`) amb què es va llegir, com l'editor: si el servidor té un
  canvi més nou, el nucli el rebutja i no es sobreescriu res (etag a CalDAV,
  `If-Match` a Google, clau de canvi a Exchange). La interfície diu «No s'ha
  pogut moure l'esdeveniment» amb el motiu i torna a llegir la finestra del servidor.
- **Convidats i notes d'Exchange.** La finestra d'Exchange no porta els
  convidats ni les notes, i l'actualització d'Exchange escriu tots dos camps:
  desar la còpia de la finestra els esborraria. Abans d'escriure un moviment en
  un calendari de compte es llegeixen amb `calendar.eventDetails`; si no es
  poden llegir, el moviment es rebutja en lloc de fer-se sense aquestes dades.
- **Un sol camí d'escriptura.** L'editor i el moviment comparteixen
  `writeEvent` (`states/calendar.ts`) i `noticePlan` (`states/organizerNotices.ts`),
  de manera que pregunten i escriuen igual. El flux del moviment és a
  `states/calendarMove.ts`.

## Proves

- `lib/calendarDrag.test.ts`: ajust a la graella, moviment, canvi de mida pels
  dos extrems, durada mínima, toc de menys de mig pas, canvi d'hora del 25 d'octubre
  (la CI executa aquest fitxer també amb `TZ=Europe/Madrid`), dies sencers,
  calendari petit, teclat i franges de creació.
- `components/calendar/CalendarInteractions.test.tsx`: moviment i canvi de mida
  amb teclat fins a l'escriptura (amb la clau de versió), Esc, rebuig de només
  lectura i de calendari desconegut, pregunta de la sèrie i cancel·lació,
  conflicte, convidats d'un calendari de compte i rebuig si no es poden llegir,
  calendari petit, creació per franja arrossegada, Esc, menú de franja i franja
  de teclat.
- `e2e/startup.e2e.ts` («calendar drag, drop and create»): els mateixos casos
  amb arrossegaments reals del punter a Chromium, inclosos la caiguda al
  calendari petit i el conflicte.

## Pendent

- Evidència nativa de Windows (N4): arrossegar a WebView2, Alt+fletxes (que a
  Chromium no han d'activar la navegació enrere) i la tecla de menú contextual.
- El calendari petit no marca els dies que tenen esdeveniments.
- Arrossegar a la visualització de mes, a l'agenda o a un altre calendari no
  forma part d'aquest canvi.
