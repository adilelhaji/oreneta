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
| Canviar l'inici o el final | Arrossegar la vora superior o inferior | Alt+Maj+fletxes amunt/avall canvien el final (un dia, en un esdeveniment de tot el dia); l'inici es canvia movent-lo i ajustant-ne després el final |
| Moure'l a un altre dia | Deixar-lo anar en un dia del calendari mensual petit, o en una altra cel·la de la franja de tot el dia | Alt+fletxa esquerra o dreta |
| Crear un esdeveniment | Arrossegar per una franja buida d'una columna; doble clic en una hora (com abans) | Franja horària que pot rebre el focus: fletxes per triar l'hora i el dia, Maj+fletxes per a la durada, Retorn |
| Crear-ne un de tot el dia | Menú contextual d'una franja buida: «Esdeveniment nou de tot el dia» | Maj+Retorn a la franja horària |
| Menú d'una franja | Clic amb el botó dret: «Esdeveniment nou» i «Esdeveniment nou de tot el dia» | Tecla de menú contextual (o Maj+F10) a la franja horària |

Les dreceres es descriuen al lector de pantalla (`calendar.timeSlotHint`,
`calendar.moveHint`) i en aquest document; no són al diàleg de dreceres de
l'aplicació, que només recull les globals.

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
  tingui 23 o 25 hores. El recorregut del punter es compta en dies i minuts de
  rellotge, i la vora agafada es mou la mateixa distància: canviar un esdeveniment de dia
  conserva l'hora del rellotge encara que hi hagi un canvi d'hora pel mig. La
  durada es conserva en temps transcorregut. La nit que s'endarrereix el
  rellotge, l'hora repetida (de 2:00 a 3:00) és una sola fila, i un
  esdeveniment que hi cau es llegeix a la primera de les dues. Un esdeveniment
  de tot el dia es mou per dates senceres (mitjanit UTC, final exclusiu).
- **On cau es calcula des del punter**, llegit respecte de la columna que hi ha
  sota tal com és ara a la pantalla, i no des de la distància recorreguda: la
  graella es desplaça sota un esdeveniment agafat. Només compta la part visible
  de la graella: deixar-lo anar damunt de les capçaleres no el porta a mitjanit.
  La graella es desplaça sola quan l'esdeveniment s'acosta a la vora superior o
  inferior (una franja del 8 % de l'alçada). S'usa `@dnd-kit` com al tauler
  kanban i a la navegació lateral (`CalendarDnd.tsx`); cap dependència nova. La
  creació per franja és una selecció, no un arrossegament d'un element, i usa
  esdeveniments de punter normals.
- **Res no arriba al servidor abans de deixar anar l'esdeveniment o de prémer Retorn.**
  Mentre s'ajusta, l'esdeveniment queda on era (atenuat) i es dibuixa on cauria;
  una línia d'estat ho diu, superposada a les visualitzacions perquè no les
  desplaci, i en el moviment amb teclat és una regió viva per al lector de
  pantalla. Un clic del punter en qualsevol lloc cancel·la un moviment amb
  teclat.
- **Calendaris que no es poden canviar.** Un calendari només de lectura o una
  subscripció rebutja el moviment abans de començar, amb el motiu i el nom del
  calendari. Un calendari que encara no s'ha carregat també el rebutja: no es
  dona per fet que s'hi pugui escriure.
- **Exchange, de moment, no.** Un esdeveniment d'un calendari d'Exchange no es
  pot moure ni canviar-ne la mida des de la graella, i el missatge ho diu i remet a
  l'editor. L'actualització d'Exchange del nucli envia `AlwaysOverwrite`
  (`meron-core/src/exchange.rs`; ja anotat a `calendar-subscriptions.md`), de
  manera que sobreescriuria un canvi fet al servidor des de l'última lectura, i
  reescriu les notes com a text pla i tots els convidats com a obligatoris. Un
  gest per canviar una hora no pot fer tot això sense dir-ho. Queda pendent d'una
  decisió del propietari (vegeu «Pendent»).
- **Sèries.** Una ocurrència d'una sèrie pregunta «Només aquest
  esdeveniment» o «Tota la sèrie», amb el mateix diàleg i les mateixes regles
  que l'editor. Què fa «Tota la sèrie» ho decideix el nucli per a cada
  proveïdor, sense canvis: a Google la sèrie conserva les seves dates i pren la
  nova hora i la nova durada, de manera que moure-la a un altre dia no en canvia
  el dia; a CalDAV tota la sèrie es desplaça el mateix interval. Si
  l'esdeveniment té convidats i se'ls pot avisar, es pregunta si se'ls avisa, com
  a l'editor.
- **Conflictes.** El moviment s'escriu amb `calendar.update` i la clau de
  versió (`change_key`) amb què es va llegir, pel mateix camí que l'editor
  (`writeEvent`, `states/calendar.ts`). Si el servidor té un canvi més nou, el
  nucli rebutja el moviment i no es sobreescriu res: a CalDAV per l'etag, i a Google per
  `If-Match` en una ocurrència sola o en un esdeveniment sense sèrie. Per a «Tota
  la sèrie» de Google, el nucli envia la versió de l'element mestre llegida en
  desar, no la que es veia: un canvi fet a la sèrie mentrestant no s'hi detecta
  (com a l'editor). La interfície diu «No s'ha pogut moure l'esdeveniment» amb
  el motiu i torna a llegir la finestra del servidor.
- **Convidats i notes d'un calendari de compte (Google).** Abans d'escriure un
  moviment es tornen a llegir amb `calendar.eventDetails` i s'escriu el que s'ha
  llegit: un convidat o unes notes trets al servidor no tornen. Si no es poden
  llegir, el moviment es rebutja en lloc de fer-se sense aquestes dades.
- **Un sol camí d'escriptura.** L'editor i el moviment comparteixen
  `writeEvent` i `noticePlan` (`states/organizerNotices.ts`), de manera que
  pregunten i escriuen igual. El flux del moviment és a `states/calendarMove.ts`.

## Proves

- `lib/calendarDrag.test.ts`: ajust a la graella, moviment, canvi de mida pels
  dos extrems, durada mínima, toc de menys de mig pas, canvi d'hora del 25
  d'octubre entre on s'agafa i on es deixa anar, i també entre l'esdeveniment
  i on s'agafa (la CI
  executa aquest fitxer també amb `TZ=Europe/Madrid`), dies sencers, calendari
  petit, on cau un esdeveniment segons el que hi ha sota (graella, fora de la
  part visible, cel·la de tot el dia, calendari petit, vores fora de la
  graella), teclat i franges de creació.
- `components/calendar/CalendarInteractions.test.tsx`: moviment i canvi de mida
  amb teclat fins a l'escriptura (amb la clau de versió) a les visualitzacions
  de setmana, de dia i de setmana laboral; Esc; rebuig de només lectura, de
  calendari desconegut i d'Exchange; pregunta de la sèrie, resposta «Tota la
  sèrie» i cancel·lació; conflicte; convidats i notes tornats a llegir d'un
  calendari de Google i rebuig si no es poden llegir; calendari petit; creació
  per franja arrossegada, Esc, menú de franja i franja de teclat.
- `e2e/startup.e2e.ts` («calendar drag, drop and create»), amb arrossegaments
  reals del punter a Chromium: moure, canviar l'inici i el final, Esc, deixar-lo
  anar al calendari petit, rebuig de només lectura, pregunta de la sèrie, un
  rebuig de `calendar.update` simulat com un conflicte, crear per franja, pel
  menú (també de tot el dia) i amb la franja de teclat, i el moviment amb
  teclat.

## Pendent

- **Decisió del propietari: Exchange.** Fer que l'actualització d'Exchange
  refusi una versió antiga (`NeverOverwrite`) i que un moviment només escrigui
  l'inici i el final; llavors es pot treure el rebuig d'Exchange. Afecta també
  l'editor.
- **Decisió del propietari: «Tota la sèrie» de Google** amb la versió de la
  sèrie que es veia, i què ha de fer moure una sèrie a un altre dia.
- Evidència nativa de Windows (N4): arrossegar a WebView2, Alt+fletxes (que a
  Chromium no han d'activar la navegació enrere) i la tecla de menú contextual.
  Les fletxes en l'ordre de lectura de dreta a esquerra no es proven; només
  es prova l'ordre d'esquerra a dreta.
- Pantalla tàctil: no s'hi pot arrossegar (només hi ha el sensor de punter).
- El calendari petit no marca els dies que tenen esdeveniments; no hi ha cap
  opció d'escala de temps.
- Arrossegar a la visualització de mes, a l'agenda o a un altre calendari no
  forma part d'aquest canvi.
