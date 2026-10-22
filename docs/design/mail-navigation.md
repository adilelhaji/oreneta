# Navegació del correu en producció (#34)

Primera adopció de la [referència del correu](mail-reference.md), autoritzada per
la instrucció de l'usuari del 2026-09-09 d'integrar comptes i carpetes amb etiqueta.

- Un panell de navegació persistent de 220 px acompanya la barra de comptes
  existent en les visualitzacions del correu de més de 1024 píxels CSS d'amplada.
  Des de #317 és el cos de la subfinestra de carpetes comuna, de 260 px per
  defecte i redimensionable (vegeu [més avall](#subfinestra-de-carpetes-comuna-317)).
  A amplades més petites, els selectors de carpeta i de compte existents continuen
  disponibles; no s'afegeix cap finestra modal ni cap estat de navegació nou.
- Les destinacions de compte fan servir `openMailAccount`; els ID de carpeta reals
  fan servir l'estat existent de carpeta seleccionada. La consulta, els filtres
  fixats, l'ordenació i les preferències d'esborrany segueixen el comportament
  existent. La navegació buida explícitament la selecció múltiple i el missatge
  obert perquè les accions no puguin apuntar en silenci a la bústia anterior.
- La jerarquia de carpetes reutilitza `buildFolderTree`, inclosos els delimitadors
  del servidor i els pares estructurals no seleccionables. Les etiquetes i els
  recomptes de no llegits provenen de la memòria cau del compte seleccionat; no es
  mostren mai carpetes obsoletes d'un altre compte.
- Les carpetes unificades fan servir els ID de rol existents i sumen els recomptes
  de la safata d'entrada només dels comptes inclosos. L'RSS conserva la seva safata
  d'entrada de canals en lloc de carpetes fictícies.
- La visibilitat dels comptes respecta les preferències de la barra, però el compte
  seleccionat en aquell moment continua sent accessible encara que estigui ocult.
  Les actualitzacions de carpetes s'observen a partir de la memòria cau existent;
  el panell no afegeix cap crida als proveïdors ni cap lògica de càrrega
  alternativa.
- Calendari, contactes, tasques i Kanban conserven les seves visualitzacions
  existents a amplada completa.

Aquest tram no tanca #34: la densitat de les files, la resposta visual de la
selecció i el comportament natiu de la bústia amb un zoom del 200 % encara
requereixen les seves pròpies proves d'acceptació. El límit del lector a 600 px es
va corregir a #85; vegeu [límits del correu](mail-boundaries.md).
No s'inclou cap migració del tema ni dels valors per defecte del lector. Les
proves cobreixen el punt d'entrada de producció real amb respostes sintètiques
del pont; no certifiquen la connectivitat amb els proveïdors.

Es proporcionen etiquetes en anglès i en castellà; els altres catàlegs fan servir
cadenes alternatives explícites en anglès a l'espera de traducció, d'acord amb el
contracte de catàlegs existent.

## Amagar carpetes (#273)

Data: 2026-10-17. Fila SET-07 (#87) de la paritat amb eM Client 10.4.

- **Què fa:** el menú contextual d'una carpeta (clic dret, Maj+F10 o la tecla
  de menú) ofereix «Amaga la carpeta». La carpeta i totes les seves
  subcarpetes surten de l'arbre, tant si la jerarquia és una ruta (IMAP,
  arxiu local, POP3, Exchange) com si són enllaços al pare (Microsoft Graph).
  Les subcarpetes es deriven del delimitador de cada carpeta o del seu pare:
  en un servidor IMAP que no anuncia delimitador (NIL), les carpetes no tenen
  jerarquia i amagar-ne una no n'amaga cap altra.
  La carpeta oberta en aquell moment es queda a l'arbre, marcada com a
  amagada, fins que se n'obre una altra.
- **Com es tornen a veure:** quan el compte obert té carpetes amagades,
  sota el quadre de filtre apareix «Mostra les carpetes amagades (N)», un
  botó de commutació (`aria-pressed`); N compta totes les carpetes que queden
  fora de l'arbre, subcarpetes incloses. Quan està activat, les carpetes
  amagades tornen a l'arbre amb una icona d'ull barrat i el text «Amagada»
  per al lector de pantalla, i el seu menú ofereix «Torna a mostrar la
  carpeta». El botó només queda activat mentre el compte és obert: en canviar
  de compte, en reiniciar l'aplicació o quan ja no queda cap carpeta amagada,
  torna a estar desactivat.
- **Només una preferència local:** les marques es desen a la preferència
  `folder_hidden` (compte + ruta de la carpeta al servidor), com les
  preferides i els colors (ADR-0050), i es comporten igual en els mateixos
  casos: un moviment de carpeta les porta a la ruta nova, suprimir la carpeta
  o treure el compte se les emporta, i una carpeta desapareguda per un altre
  camí les perd sense avís (com els colors; l'avís és només per a les
  preferides). Cap servidor no se n'assabenta i el nucli no les llegeix: una
  carpeta amagada es continua sincronitzant exactament igual, i amagar o
  mostrar no envia res més que l'escriptura de la preferència. Si l'escriptura
  falla, com amb les preferides i els colors, la carpeta torna a aparèixer en
  el proper engegament.
- **Amagar no protegeix el contingut:** només treu la carpeta de l'arbre. La
  marca viatja a la còpia de configuració, com les preferides i els colors.
- **Què no es pot amagar:** la safata d'entrada, ni una carpeta que la
  contingui (és on s'obre cada compte). Una subcarpeta que ja queda amagada
  per la seva carpeta pare no s'amaga per separat; el menú ho diu.
- **On continuen visibles:** a Preferides, si la persona les hi ha posades
  expressament; als selectors de destinació (per moure missatges o carpetes,
  per a les columnes del tauler o per a les regles) i al selector de carpeta
  de la capçalera de la llista, que serveixen per triar una carpeta concreta.
  Els missatges d'una carpeta amagada continuen sortint a les carpetes
  unificades, a Destacats i a les columnes del tauler (i a la seva cerca).
  Moure una carpeta dins d'una d'amagada la treu de l'arbre amb ella, i els no
  llegits d'una carpeta amagada no es veuen fins que es mostra.
- **Avisos i focus:** amagar o tornar a mostrar es diu per una regió
  `aria-live` («S'ha amagat Feina»). Quan una carpeta s'amaga des del seu menú
  a l'arbre i en surt, el focus passa al botó «Mostra les carpetes amagades».
- **Cerca:** la cerca busca a la carpeta oberta. «Opcions de cerca» diu
  on busca i si hi entren les carpetes amagades: amb una carpeta oberta, no
  (o bé que la mateixa carpeta oberta és amagada); en una carpeta unificada,
  sí: el nucli hi busca la carpeta d'aquell tipus de cada compte inclòs a les
  carpetes unificades, encara que aquesta carpeta sigui amagada (la safata
  d'entrada mai no ho és); a Destacats, que inclou totes les carpetes, també.
  La línia d'àmbit és dins d'«Opcions de cerca», no al costat del quadre de
  cerca.
- **Fora d'abast:** l'aplicació mòbil i desar les marques al servidor.
- **Proves:** `frontend/src/lib/folderHiding.test.ts` (què surt de l'arbre
  per ruta i per pare, què no es pot amagar, l'àmbit de la cerca),
  `frontend/src/states/folderPrefs.test.ts` (amagar, mostrar, desar, llegir
  en engegar i seguir moviments i supressions),
  `frontend/src/components/sidenav/MailNavigation.test.tsx` (el menú, el botó
  de commutació, el focus, la carpeta oberta, la safata d'entrada i
  Preferides) i `frontend/src/components/threads/SearchBuilder.test.tsx` (la
  línia d'àmbit).

## Subfinestra de carpetes comuna (#317)

Data: 2026-10-21. Pas 2 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§4, §7 i §9), primer al
correu; els altres mòduls hi entren després, un per PR. El Calendari hi va entrar
el 2026-10-22 ([més avall](#calendari-323)).

- **Què és:** un sol component, `frontend/src/components/shell/FolderPane.tsx`,
  amb una fila de títol de 40 px al 100 % (2,5 rem, de manera que creix amb el
  zoom de l'aplicació, decisió del propietari del 2026-10-21), el cos que hi posa el
  mòdul, una ranura de peu opcional (el minicalendari, peça 4) i, al peu de tot,
  el lloc del selector de mòduls (peça 14). Al correu, el peu i el selector són
  buits.
- **Correu:** el cos és la navegació d'aquesta pàgina, sense canvis de
  contingut: carpetes preferides, safata d'entrada unificada, grups de comptes,
  comptes, filtre i arbre de carpetes, i les carpetes amagades de #273 amb
  «Mostra les carpetes amagades». Les cerques desades continuen on eren: al
  selector «Canvia de carpeta» i al menú de cerques de la llista; el propietari
  va decidir el 2026-10-21 que passin a la subfinestra en un pas posterior
  (#319). La barra vertical i els taulers kanban no es mouen (peça 14); amb un
  tauler obert, la subfinestra no es mostra, com abans.
- **Regió i noms:** la subfinestra és el `<nav>` de la regió «carpetes» d'F6
  (`data-region="folders"`) i pren el nom de la seva fila de títol: «Comptes i
  carpetes», el mateix d'abans. El títol és un encapçalament de nivell 2, i
  «Preferits», «Comptes» i «Carpetes» passen a ser-ho de nivell 3. Fins que la
  barra vertical se'n vagi (pas 4), la subfinestra continua dins de `<main>`,
  just després de la barra.
- **Amplada:** 260 px per defecte, de 200 a 400, amb el separador `PaneResizer`
  d'ADR-0059 a la vora final («Canvia la mida del panell de carpetes»): punter,
  fletxes (16 px; amb Maj, 64), Inici i Fi, en el sentit de lectura també en
  àrab, i la mida dibuixada. Es desa a la preferència nova `folder_pane_width`,
  una per a tots els mòduls, i s'ajusta als límits en llegir-la. Com que és en
  px, el zoom de l'aplicació fa créixer el text i no la subfinestra; un títol o
  un nom que no hi cap acaba en «…» i la indicació el mostra sencer (als comptes,
  el nom i l'adreça).
- **Quan l'espai no arriba:** les carpetes cedeixen fins a 200 px abans que la
  llista, i la llista fins a 280 px abans que el lector, que en conserva 360. Amb
  una llista desada de 560 px i la barra vertical de 60 px: a 1200 px, carpetes
  de 220 px i la llista sencera; a 1100 i 1025 px, carpetes de 200 px i una
  llista de 480 i 405 px.
- **Per sota de 1025 px** la subfinestra no es mostra, com la navegació d'abans,
  i el selector «Canvia de carpeta» de la llista dona accés a les carpetes.
- **Efecte en la barra lateral de detalls:** amb la barra vertical i la
  subfinestra de 260 px (abans 220), la fila del lector fa 40 px menys. A
  1440 px, amb la llista per defecte, la barra lateral de detalls arriba com a
  màxim a 400 px al costat del lector (abans, 440). Que les carpetes i la llista
  cedeixin també davant d'aquesta barra és la peça 12 (ADR-0069 §2); el
  propietari va acceptar el 2026-10-21 que fins aleshores la barra tingui aquest
  espai menys.
- **Proves:** `frontend/src/components/shell/FolderPane.test.tsx` (regió i nom,
  títol amb indicació, peu i lloc del selector, amplada en px, teclat i punter
  en totes dues direccions, mida dibuixada, amplada desada, recuperada i
  ajustada), `frontend/src/states/settings.test.ts` i
  `frontend/src/lib/paneResize.test.ts` (valor per defecte i límits),
  `frontend/src/components/sidenav/MailNavigation.test.tsx` (el correu dins de
  la subfinestra i les indicacions dels noms) i `frontend/e2e/startup.e2e.ts`
  («#317»: teclat, punter, reinici i zoom del 200 % a 1440 px; qui cedeix a
  1025, 1100, 1200 i 1440 px; àrab).

### Calendari (#323)

Data: 2026-10-22. El segon mòdul del pas 2: la columna de calendaris del
Calendari passa a ser la subfinestra de carpetes comuna, amb el mateix contingut
(ADR-0068 §4, fila del Calendari).

- **Cos i peu:** el cos és la llista de calendaris de `CalendarList.tsx`,
  agrupats per compte: la casella de color que els mostra o els amaga, el nom,
  que obre el menú de colors, i el cadenat dels que són només de lectura, com les
  subscripcions. Al peu hi ha el calendari mensual petit (`MiniCalendar.tsx`, el
  minicalendari d'ADR-0068 §4): un dia obre aquell dia a la visualització
  activa, «Mes anterior» i «Mes següent» en canvien el mes, i s'hi pot deixar
  anar un esdeveniment de la graella (#266). Abans el calendari petit era a dalt
  de la columna; l'ADR el posa al peu.
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 del Calendari i es
  diu «Calendaris», com demana ADR-0068 §1; es fa servir la cadena
  `mobile.calendar.calendars`, que ja és a tots els catàlegs. Abans, la llista
  era un `<aside>` «Calendari», amb el mateix nom que `<main>`; ara és el cos de
  la subfinestra i no és una regió pròpia. La subfinestra és dins de `<main>`,
  just després de la barra vertical i abans del mòdul. La capçalera del
  calendari (període, navegació, visualitzacions i «Esdeveniment nou») queda a la
  regió del contingut, al costat.
- **La llista omple el cos de la subfinestra**, com omplia la columna: el menú de
  colors de l'últim calendari s'obre en aquest espai i no fa desplaçar la llista.
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador
  que al correu: redimensionar-la al Calendari la canvia al correu, i a
  l'inrevés. Abans la columna feia 12 rem (192 px al 100 %) i creixia amb el zoom
  de l'aplicació; ara és en px, i al 200 % hi creix el text, no la subfinestra.
  Perquè el calendari petit hi càpiga, cada dia ocupa com a màxim la setena part
  de l'amplada, sense passar dels 1,5 rem d'abans; al 100 % es veu igual. Una
  adreça de compte que no hi cap acaba en «…» i la indicació la mostra sencera.
- **Espai a 1025 px:** les visualitzacions no tenen amplada mínima, de manera
  que la subfinestra no ha de cedir. Amb la barra vertical de 60 px, al mòdul li
  queden 765 px amb la subfinestra al mínim (200 px), 705 px amb la de per
  defecte (260 px) i 565 px amb la màxima (400 px). El dia, la setmana i el mes
  hi caben sense desplaçament horitzontal.
- **Per sota de 1025 px** la subfinestra no es mostra, i ADR-0068 no diu on van
  llavors els calendaris (al correu hi ha el selector «Canvia de carpeta»).
  Mentre el propietari no ho decideixi, es conserva la columna d'abans dins del
  mòdul, sota la capçalera, amb el mateix contingut i el mateix ordre: entre 769
  i 1024 px, de 12 rem, amb el calendari petit a dalt i la llista a sota; per
  sota de 769 px, només la llista, a sobre de les visualitzacions. És la mateixa
  regió «carpetes», ara també amb el nom «Calendaris». En passar de 1024 a
  1025 px, o a l'inrevés, els calendaris canvien de lloc, i mai no són als dos
  llocs alhora.
- **Del Calendari d'abans, encara pendent:** al 200 % de l'aplicació a 1024 i
  1025 px la setmana no hi cap i se'n tallen els últims dies (a c62e11ca, de
  dimecres a dissabte; ara, de dijous a dissabte). Amb la subfinestra al mínim,
  el menú de colors sobresurt uns 5 px de la llista i se'n talla una mica
  l'últim color (a la columna de 12 rem, uns 13 px). Cap dels dos no ve de la
  subfinestra.
- **Proves:** `frontend/src/components/calendar/CalendarFolderPane.test.tsx` (la
  subfinestra al costat del mòdul i amb el seu nom, la llista amb els mateixos
  controls, el calendari petit al peu, l'amplada compartida amb el correu, la
  columna a 1024 px i el pas d'un lloc a l'altre) i `frontend/e2e/startup.e2e.ts`
  («#323»: dia, setmana i mes a 1025, 1100 i 1440 px amb la subfinestra a 200,
  260 i 400 px; la columna a 1024 px; mostrar, amagar i canviar el color d'un
  calendari a la subfinestra, amb el menú de colors sencer, i a la columna;
  l'amplada desada des del Calendari i des del correu amb el teclat, el punter i
  un reinici; l'àrab, amb axe; el 200 % a 1440 i 1025 px). Les proves del
  calendari que ja hi havia no canvien d'expectativa: la d'arrossegar fins al
  calendari petit comprova, a més, que a 1440 px el dia és a la subfinestra, i
  el recorregut d'F6 de #306 és el mateix (el mòdul, la subfinestra i la barra
  vertical).
