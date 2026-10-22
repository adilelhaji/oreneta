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
el 2026-10-22 ([més avall](#calendari-323)), i Persones, Tasques, Notes, Xat i
Adjunts el mateix dia (vegeu [Persones](#persones-326), [Tasques](#tasques-329),
[Notes](#notes-335), [Xat](#xat-337) i [Adjunts](#adjunts-339) més avall).

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
  diu «Calendaris», com demana ADR-0068 §1, amb una cadena pròpia de
  l'escriptori, `calendar.calendars` (decisió del propietari del 2026-10-22). En
  alemany, japonès, coreà, vietnamita i xinès, el plural de «calendari» és la
  mateixa paraula que el nom de `<main>` (`calendar.title`), i ADR-0068 §1 no
  deixa que dues regions comparteixin nom: allà la subfinestra es diu, per
  exemple, «Kalenderliste» o «カレンダー一覧», i una prova verifica en tots els
  catàlegs que no coincideix ni amb `<main>` ni amb el calendari petit. Abans, la
  llista era un `<aside>` «Calendari», amb el mateix nom que `<main>`; ara és el
  cos de la subfinestra i no és una regió pròpia. La subfinestra és dins de
  `<main>`, just després de la barra vertical i abans del mòdul. La capçalera del
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
  El nom d'un calendari, també: la indicació del botó del nom, que obre el menú
  de colors, diu el nom sencer i l'acció, per exemple «Feina — Color»
  (`calendar.nameAndColor`, decisió del propietari del 2026-10-22), i el nom
  accessible del botó continua sent el del calendari.
- **Espai a 1025 px:** les visualitzacions no tenen amplada mínima, de manera
  que la subfinestra no ha de cedir. Amb la barra vertical de 60 px, al mòdul li
  queden 765 px amb la subfinestra al mínim (200 px), 705 px amb la de per
  defecte (260 px) i 565 px amb la màxima (400 px). El dia, la setmana i el mes
  hi caben sense desplaçament horitzontal.
- **Per sota de 1025 px** la subfinestra no es mostra, i ADR-0068 no diu on van
  llavors els calendaris (al correu hi ha el selector «Canvia de carpeta»). El
  propietari va decidir el 2026-10-22 que, fins a la peça 14, s'hi conservi la
  columna d'abans dins del mòdul, sota la capçalera, amb el mateix contingut i el
  mateix ordre: entre 769 i 1024 px, de 12 rem, amb el calendari petit a dalt i
  la llista a sota; per sota de 769 px, només la llista, a sobre de les
  visualitzacions. És la mateixa regió «carpetes», ara també amb el nom
  «Calendaris». En passar de 1024 a 1025 px, o a l'inrevés, els calendaris
  canvien de lloc, i mai no són als dos llocs alhora.
- **Ja existia al Calendari i continua pendent:** al 200 % de l'aplicació a
  1024 i 1025 px la setmana no hi cap i se'n tallen els últims dies (a c62e11ca,
  de dimecres a dissabte; ara, de dijous a dissabte). Amb la subfinestra al
  mínim, el menú de colors sobresurt uns 5 px de la llista i se'n talla una mica
  l'últim color (a la columna de 12 rem, uns 13 px). Cap dels dos no ve de la
  subfinestra.
- **Proves:** `frontend/src/components/calendar/CalendarFolderPane.test.tsx` (la
  subfinestra al costat del mòdul i amb el seu nom, diferent del de `<main>` en
  tots els catàlegs; la llista amb els mateixos controls i la indicació del nom;
  el calendari petit al peu; l'amplada compartida amb el correu; la columna a
  1024 px i el pas d'un lloc a l'altre),
  `frontend/src/components/shell/FolderPane.test.tsx` (l'amplada de finestra a
  partir de la qual es pinta la subfinestra, la mateixa que llegeix el
  Calendari) i `frontend/e2e/startup.e2e.ts` («#323»: agenda, dia, setmana i mes
  a 1025, 1100 i 1440 px amb la subfinestra a 200, 260 i 400 px; la columna a
  1024 px; mostrar, amagar i canviar el color d'un calendari a la subfinestra,
  amb el menú de colors sencer, i a la columna; l'amplada desada des del
  Calendari i des del correu amb el teclat, el punter i un reinici; l'àrab, amb
  axe; el 200 % a 1440 i 1025 px). Les proves del
  calendari que ja hi havia no canvien d'expectativa: la d'arrossegar fins al
  calendari petit comprova, a més, que a 1440 px el dia és a la subfinestra, i
  el recorregut d'F6 de #306 és el mateix (el mòdul, la subfinestra i la barra
  vertical).

### Persones (#326)

Data: 2026-10-22. El tercer mòdul del pas 2: els grups de la llibreta
d'adreces passen a ser la subfinestra de carpetes comuna, amb el mateix contingut
que el filtre d'abans (ADR-0068 §4, fila de Persones).

- **Decisió del propietari (2026-10-22):** la subfinestra es diu «Grups de
  contactes» i no «Llibretes i grups», com deia la fila de l'ADR, perquè
  Persones no té cap selecció de llibreta: només filtra per grup. Que les
  llibretes hi surtin també (triar-ne una, agrupar-hi els grups, què fa «Contacte
  nou» amb una llibreta triada) és la incidència #327, i no s'ha fet aquí.
- **Cos:** «Tots els contactes» i cada grup, amb quantes persones té, i a dalt
  les accions que la fila del filtre ja tenia: «Grup nou» (que obre
  `GroupDialog`) i, amb un grup triat, escriure a tothom (inactiu si cap membre
  no té adreça), canviar-li el nom i suprimir-lo; aquestes dues només per als
  grups que la llibreta pot escriure (locals, CardDAV i d'Exchange), com abans.
  Com que la fila és sobre la llista, cada acció diu quin grup afecta amb el nom
  accessible i la indicació: «Escriu a tothom de Climbing» (`people.writeToGroup`,
  que ja existia), «Canvia el nom de Climbing» (`people.renameGroupNamed`) i
  «Suprimeix Climbing» (`people.deleteGroupNamed`). «Grup nou» no canvia. Triar
  un grup filtra la llista, com el desplegable d'abans, i el filtre es manté en
  passar de 1024 a 1025 px i a l'inrevés. Els grups d'Exchange i la confirmació de
  suprimir-los («se suprimirà de la llibreta d'adreces del seu servidor») no
  canvien. La fila triada té `aria-current="true"`, com el cos del correu. El nom
  d'un grup que no hi cap acaba en «…»; la indicació el mostra sencer amb el
  recompte, per exemple «Climbing (2)» (`people.groupOption`, que ja existia), i
  és també el nom accessible del botó, com abans ho era el de l'opció del
  desplegable. Persones no té arrossegar i deixar anar ni menús contextuals a la
  columna, de manera que no se n'ha hagut de moure cap.
- **Què queda a la llista:** la capçalera (títol, importar, exportar, «Contacte
  nou», cerca i l'avís de possibles duplicats) i la llista de persones continuen
  al mòdul, en una columna de 288 px al costat de la subfinestra (18 rem per
  sota de 1025 px), i els detalls de la persona al seu costat. És el que l'ADR
  anomena la llista, no les carpetes.
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 de Persones i es diu
  «Grups de contactes» (`people.contactGroups`), una cadena pròpia de l'escriptori
  i diferent de `<main>` («Persones») i de «Grups» (el títol d'una secció de la
  fitxa, `people.groups`) en els 20 catàlegs, com comprova una prova. Abans, la
  regió «carpetes» era la columna de la llista, una `<section>` sense nom: ara és
  la subfinestra, que és a `<main>`, just després de la barra vertical i abans
  del mòdul, i la llista és només el contingut. F6 va de la barra vertical al
  mòdul, a la subfinestra i altre cop a la barra.
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador
  que al correu i al Calendari: redimensionar-la a Persones la canvia a tots dos, i a
  l'inrevés, en px. Al costat de la subfinestra, la columna de la llista fa
  288 px (18 rem al 100 %) i no creix amb el zoom de l'aplicació, i a la seva
  capçalera el títol i les accions passen a una línia nova si no hi caben:
  sense això, al 200 % a 1025 px, la fitxa de la persona es quedava a 129 px. Per
  sota de 1025 px la columna segueix sent de 18 rem.
- **Espai a 1025 px:** el mòdul demana 648 px com a base (la llista de 288 px i
  els 360 px de la fitxa de la persona, el mínim del lector d'ADR-0068 §7), i la
  subfinestra, que cedeix abans que res, s'encongeix fins a donar-los-hi. Amb la
  barra vertical de 60 px i la llista de 288 px, la fitxa té 477 px amb la
  subfinestra al mínim (200 px) i 417 px amb la de per defecte (260 px); amb la
  màxima (400 px) la subfinestra es pinta a 317 px i la fitxa en té 360. Cap
  control no surt del mòdul i no hi ha desplaçament horitzontal. Al 200 % de
  l'aplicació a 1025 px la barra vertical fa 120 px, la subfinestra per defecte
  cedeix fins a uns 257 px i la fitxa en conserva uns 360.
- **Per sota de 1025 px** la subfinestra no es mostra. Com va decidir el
  propietari per al Calendari, es conserva la disposició d'abans: el filtre de
  grups (desplegable «Mostra el grup» i les mateixes quatre accions) sota la
  capçalera de la llista. Mai no són a dos llocs alhora.
- **Proves:** `frontend/src/components/people/PeopleFolderPane.test.tsx` (la
  subfinestra al costat del mòdul i amb el seu nom, diferent del de `<main>` i del
  de «Grups» en tots els catàlegs; els grups amb el recompte, la indicació i el
  nom accessible; triar, crear, canviar el nom, escriure i suprimir, també un grup
  d'Exchange confirmat; un grup que no es pot escriure; l'amplada compartida amb
  el correu; el filtre a 1024 px i el pas d'un lloc a l'altre) i
  `frontend/e2e/startup.e2e.ts` («#326»: la llista i la persona a 1025, 1100 i
  1440 px amb la subfinestra a 200, 260 i 400 px, sense desplaçament horitzontal;
  el filtre a 1024 px; triar, crear i canviar el nom d'un grup; l'amplada desada
  des de Persones i des del correu amb el teclat, el punter i un reinici; l'àrab,
  amb axe; el 200 % a 1440 i 1025 px). El recorregut d'F6 de #306 hi afegeix
  Persones, i la prova de SET-19 (grups i noms de contacte) tria el grup a la
  subfinestra a 1440 px, perquè el desplegable només és per sota de 1025 px.

### Tasques (#329)

Data: 2026-10-22. El quart mòdul del pas 2: les llistes de tasques, que fins ara
eren pestanyes sota la capçalera, passen a ser la subfinestra de carpetes comuna
(ADR-0068 §4, fila de Tasques: «Canvi de lloc»).

- **Decisions del propietari (2026-10-22):** la subfinestra es diu «Llistes de
  tasques» (`tasks.taskLists`), i els avisos de les llistes de compte
  (ADR-0070) continuen com a bandes sobre les tasques, no a la subfinestra.
- **Cos:** «Totes» i cada llista, amb el mateix ordre i els mateixos recomptes
  que les pestanyes (les tasques obertes; «Totes» i una llista sense cap tasca
  oberta no en mostren): la llista de seguiment del correu, les locals, les
  CalDAV i les que arriben amb un compte (ADR-0070, #281). La fila triada té
  `aria-current="true"`. El nom que no hi cap acaba en «…»; la indicació el
  mostra sencer amb el recompte, per exemple «Home (2)» (`tasks.listOption`), i
  és també el nom accessible del botó. Triar una llista filtra les tasques com
  la pestanya, i la tria es manté en passar de 1024 a 1025 px i a l'inrevés.
- **Teclat:** les pestanyes es movien amb les fletxes (`handleGroupArrowKeys`,
  ADR-0061) i triaven la llista en arribar-hi. Les files de la subfinestra
  conserven aquesta semàntica, amb l'orientació vertical, que és la d'una llista
  de files: Amunt i Avall (cíclics), Inici i Final, que també trien la llista;
  igual de dreta a esquerra. Les fletxes cap a l'inici i cap al final de la línia
  ja no hi mouen res. La subfinestra pren les tecles: no arriben a la navegació
  de la llista de converses del correu (`AppHotkeys`), que si no canviaria la
  conversa oberta. Fins que arribi l'arbre de carpetes (ADR-0068 §4), el
  mòdul manté la semàntica que tenia.
- **Accions:** a dalt, com a Persones, «Llista nova» (que demana el nom allà
  mateix, com abans), «Llista de tasques CalDAV…» (que obre el mateix diàleg) i,
  amb una llista triada que no sigui la del correu, canviar-li el nom i
  suprimir-la; com que la fila és sobre la llista, aquestes dues diuen quina
  llista afecten amb el nom accessible i la indicació: «Canvia el nom de Home»
  (`tasks.renameListNamed`) i «Suprimeix Home» (`tasks.deleteListNamed`). Les
  confirmacions de suprimir, també les de les llistes d'un compte i les de CalDAV
  («no se suprimeix res al servidor»), no canvien. «Afegeix una llista», per a
  les llistes de compte que s'han declinat (ADR-0070), és a sota de la llista i
  s'obre dins la subfinestra, no com a menú flotant, que la vora de la
  subfinestra tallaria.
- **Camp del nom i focus:** el camp de «Llista nova» és sota la llista i sota
  «Afegeix una llista», de manera que obrir-lo o tancar-lo no mou cap fila: si
  es tanqués en perdre el focus, el primer clic sobre una llista es perdria,
  perquè les files pujarien sota el punter abans que s'acabés. Per això no es
  tanca en perdre el focus: es tanca amb Retorn (que crea la llista, si té nom) o
  amb Esc (que la cancel·la), i el focus torna al botó «Llista nova». Després
  de suprimir una llista confirmada, el focus va a «Totes», que és on va la
  tria; si la confirmació es declina, el focus es queda al botó.
- **Què queda al mòdul:** els avisos de les llistes de compte (les que s'estan
  llegint, les que no s'han pogut llegir i l'avís d'una llista afegida en
  actualitzar), l'estat de sincronització d'una llista amb servidor i els
  conflictes no són llistes, i continuen sobre les tasques, com abans. També la
  capçalera (títol, «Mostra les completades», «Tasca nova») i la cerca. Tasques
  no té cap filtre d'estat a part de «Mostra les completades», ni reordenació de
  llistes, ni arrossegar i deixar anar, ni menús contextuals a les pestanyes, de
  manera que no se n'ha hagut de moure cap.
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 de Tasques i es
  diu «Llistes de tasques» (`tasks.taskLists`), una cadena pròpia de
  l'escriptori i diferent de `<main>` («Tasques») en els 20 catàlegs, com
  comprova una prova. Abans Tasques no tenia cap regió «carpetes». F6 va de la
  barra vertical al mòdul, a la subfinestra i altre cop a la barra.
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador
  que al correu, al Calendari i a Persones, en px. Com al Calendari, el mòdul no
  té una llista i una fitxa de mides fixes, sinó una sola columna de tasques que
  s'adapta, de manera que no demana cap base i la subfinestra es pinta sempre
  a l'amplada triada (de 200 a 400 px); les tasques ocupen la resta, amb les
  capçaleres que passen a una línia nova si no hi caben.
- **Per sota de 1025 px** la subfinestra no es mostra i es conserven les
  pestanyes d'abans, amb «Llista nova», «Llista de tasques CalDAV…», «Afegeix
  una llista», «Canvia el nom de la llista» i «Suprimeix la llista», com va
  decidir el propietari per al Calendari i Persones. Mai no són a dos llocs
  alhora. Travessar els 1025 px canvia de lloc els controls, i el que s'hi
  estava escrivint es perd: un nom de llista a mig escriure o la contrasenya del
  diàleg de CalDAV. La llista triada es manté.
- **Proves:** `frontend/src/components/tasks/TasksFolderPane.test.tsx` (la
  subfinestra al costat del mòdul i amb el seu nom, diferent del de `<main>` en
  tots els catàlegs; les llistes amb el recompte, la indicació i el nom
  accessible; triar, crear, cancel·lar, canviar el nom i suprimir, amb el
  focus; les fletxes, també de dreta a esquerra; el diàleg CalDAV; «Afegeix una
  llista» i els avisos que es queden al mòdul; «Totes» amb una llista de compte
  pendent; l'amplada compartida amb el correu; les pestanyes a 1024 px i el pas
  d'un lloc a l'altre) i `frontend/e2e/startup.e2e.ts` («#329»: les tasques a
  1025, 1100 i 1440 px amb la subfinestra a 200, 260 i 400 px, sense
  desplaçament horitzontal; les pestanyes a 1024 px; triar, canviar el nom,
  suprimir i crear una llista; un sol clic sobre una llista o sobre «Afegeix una
  llista» amb el camp del nom obert; l'amplada desada des de Tasques i des del
  correu amb el teclat, el punter i un reinici; l'àrab, amb axe; el 200 % a
  1440 px i a 1025 px amb la subfinestra a 260 i 400 px). El recorregut d'F6 de
  #306 hi afegeix Tasques.

### Notes (#335)

Data: 2026-10-22. El cinquè mòdul del pas 2: les etiquetes de les notes, que fins
ara eren botons sobre la llista de notes, passen a ser el cos de la subfinestra de
carpetes comuna (ADR-0068 §4, fila de Notes).

- **Cos:** «Totes les notes» i cada etiqueta amb quantes notes té, en el mateix
  ordre i amb els mateixos recomptes que els botons d'abans (els que respon el
  nucli). «Totes les notes» (`notes.allNotes`) treu el filtre. Triar una etiqueta
  posa `notes$.tag`, i tornar a triar l'etiqueta ja triada treu el filtre, com el
  botó. La fila triada té `aria-current="true"`. El nom que no hi cap acaba en
  «…»; la indicació el mostra sencer amb el recompte, per exemple «#viatge (2)»
  (`notes.tagOption`), i és el nom accessible del botó. La tria es manté en passar de 1024 a
  1025 px i a l'inrevés.
- **Teclat:** com a Tasques, les files es mouen amb Amunt, Avall, Inici i Final
  (`handleGroupArrowKeys`, orientació vertical, ADR-0061), trien l'etiqueta en
  arribar-hi i prenen les tecles: no arriben a la navegació de la llista de
  converses del correu.
- **Paperera:** a la paperera no s'ofereixen etiquetes, com abans. La subfinestra
  no mostra les files i diu «La paperera no es filtra per etiqueta»
  (`notes.trashNoTags`); en sortir-ne, les files tornen. Perquè la frase sigui
  certa, `loadNotes` no envia l'etiqueta a la paperera: abans, una etiqueta triada
  abans d'entrar-hi seguia filtrant-la, sense cap botó per treure-la, i la
  paperera semblava buida. L'etiqueta triada es conserva i torna a aplicar-se en
  sortir de la paperera.
- **Què queda a la llista:** la cerca (a dalt de la llista; passarà a la banda
  superior en una peça posterior), «Paperera» i «Nota nova» a la capçalera, la
  llista de notes i l'editor. La columna de la llista és de 320 px (20 rem a
  1024 px i menys) i el mòdul demana 680 px com a base (la llista i els 360 px de
  la nota, el mínim del lector d'ADR-0068 §7): la subfinestra, que cedeix abans
  que res, s'encongeix fins a donar-los-hi. A 1025 px, amb la barra vertical de
  60 px, la subfinestra de 400 px es pinta a uns 285 px.
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 de Notes i es diu
  «Etiquetes de notes» (`notes.tagsPane`), diferent de `<main>` («Notes»), de la
  llista («Notes»), de «Etiquetes» i de la resta de noms de regió en els 20
  catàlegs, com comprova una prova. La columna de la llista ja no té
  `data-region="folders"` a partir de 1025 px.
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador
  que al correu, al Calendari, a Persones i a Tasques, en px.
- **Per sota de 1025 px** la subfinestra no es mostra i es conserven els botons
  d'etiqueta sobre la llista, amb la columna com a regió «carpetes». Mai no són a
  dos llocs alhora.
- **Proves:** `frontend/src/components/notes/NotesFolderPane.test.tsx` (la
  subfinestra al costat del mòdul i amb el seu nom; les files amb el recompte, la
  indicació i el nom accessible; triar, tornar a triar i «Totes les notes»;
  `aria-current`; les fletxes; la paperera; l'amplada compartida; el nom diferent
  del de les altres regions en els 20 catàlegs; els botons a 1024 px i el pas
  d'un lloc a l'altre) i `frontend/e2e/startup.e2e.ts` («#335»: la llista i la
  nota a 1025, 1100 i 1440 px amb la subfinestra a 200, 260 i 400 px, sense
  desplaçament horitzontal; els botons a 1024 px; triar, treure i la paperera;
  l'amplada desada des de Notes i des del correu; l'àrab, amb axe). El
  recorregut d'F6 de #306 hi afegeix Notes.

### Xat (#337)

Data: 2026-10-22. El sisè mòdul del pas 2: la columna de converses de Xat, de 18
rem, passa a ser la subfinestra de carpetes comuna (ADR-0068 §4, fila de Xat).

- **Cos:** el mateix contingut i el mateix ordre que la columna, peu inclòs. Primer
  la fila del compte (el selector de compte o l'adreça, la insígnia de mencions
  sense llegir i l'estat de la connexió), després el teu estat, les peticions de
  veure l'estat i els permisos d'estat, «Xateja amb», «Uneix-te a un grup» (o el seu formulari), les
  invitacions, els grups, les converses directes i, al peu de la subfinestra,
  «Elimina aquest compte de xat». El títol de la subfinestra és
  «Converses» (`messaging.conversations`), la clau que ja era el nom de la
  columna: no hi ha cap cadena nova. Els botons de navegació compacta i la icona
  de xat de la capçalera de la columna no hi són, perquè la subfinestra ja té la
  seva fila de títol de 2,5 rem. Obrir una conversa, canviar de compte, unir-se a
  un grup i la resta fan el mateix que a la columna.
- **Conversa oberta:** com que la fila de la conversa oberta és sobre el fons de la
  subfinestra (`--me-bg-app`), més fosc que el de la columna (`--me-bg-chats`), el
  to `accent/10` que la marcava deixava el text secundari de l'últim missatge
  per sota de 4,5:1. A la subfinestra la fila oberta es marca com la carpeta
  triada de la subfinestra del correu: fons `bg-active` i nom en `accent-fg`,
  perquè el fons sol gairebé no es distingeix del de la subfinestra. A la
  columna d'abans no canvia res.
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador que
  al correu, al Calendari, a Persones, a Tasques i a Notes, en px. La conversa
  oberta demana 360 px com a base (`flex-[1_1_360px]`, el mínim del lector
  d'ADR-0068 §7): la subfinestra, que cedeix abans que res, s'encongeix fins a
  donar-los-hi. `w-72` desapareix a la subfinestra.
- **Regió i nom:** la subfinestra és l'única regió «carpetes» d'F6 de Xat i es diu
  «Converses», diferent de `<main>` («Xat»), de «Grups», de «Converses directes»,
  d'«Invitacions» i de la resta de noms de regió en els 20 catàlegs, com comprova
  una prova. No ha calgut canviar cap nom.
- **Per sota de 1025 px** la subfinestra no es mostra i es conserva la columna d'abans
  tal com és (de 18 rem, a tota l'amplada per sota de 769 px, amb el flux de tornada
  quan hi ha una conversa oberta). Mai no són a dos llocs alhora. Sense cap compte,
  `ChatSetup` es manté.
- **Proves:** `frontend/src/components/messaging/MessagingFolderPane.test.tsx` (la
  regió i el seu nom; el cos i l'ordre; obrir una conversa; canviar de compte;
  l'amplada compartida i la base de 360 px; el nom diferent del de les altres
  regions en els 20 catàlegs; la columna a 1024 px i el pas de 1024 a 1025 px amb
  la conversa oberta) i `frontend/e2e/startup.e2e.ts` («#337»: la conversa a 1025,
  1100 i 1440 px amb la subfinestra a 200, 260 i 400 px, sense desplaçament
  horitzontal; la columna a 1024 px; l'amplada desada des de Xat i des del correu;
  l'àrab, amb axe). El recorregut d'F6 de #306 hi afegeix Xat.

### Adjunts (#339)

Data: 2026-10-22. El setè mòdul del pas 2: la barra de filtres d'Adjunts, que era
sota la capçalera, passa a ser el cos de la subfinestra de carpetes comuna
(ADR-0068 §4). Adjunts no tenia cap columna de «carpetes».

- **Cos:** els mateixos cinc filtres, en l'ordre d'abans i lligats al mateix
  `attachmentList$.filter` amb el mateix retard de 200 ms en els camps de text:
  nom del fitxer, remitent, tipus, quan i, només amb més d'un compte, compte. Van
  apilats, un per fila, cadascun amb una etiqueta visible (`<label>`, amb el
  mateix text que el nom accessible d'abans: «Nom del fitxer», «De», «Tipus»,
  «Quan», «Compte»). Cada control conserva el seu nom accessible, de manera que
  els localitzadors existents continuen funcionant. Els camps i els selectors són
  `w-full min-w-0`, perquè un compte amb una adreça llarga cedeixi davant de la
  subfinestra en lloc d'empènyer-ne el cos de costat. No hi ha cap cadena de
  filtre nova.
- **Títol:** la clau nova `attachmentsView.filters`, «Filtres d'adjunts»
  (traduïda als 20 catàlegs).
- **Amplada:** la mateixa preferència `folder_pane_width` i el mateix separador que
  al correu, al Calendari, a Persones, a Tasques, a Notes i a Xat, en px. El
  contingut demana 360 px com a base (`flex-[1_1_360px]`, el mínim de la llista
  d'ADR-0068 §7): la subfinestra, que cedeix abans que res, s'encongeix fins a
  donar-los-hi.
- **Un sol arbre en els dos modes:** la subfinestra i el contingut són germans, i la
  llista té la mateixa posició entre els fills del contingut a 1024 px i a 1025
  px (el que canvia és si la barra hi és o no). Travessar els 1025 px no torna a
  muntar la llista ni en perd el desplaçament; els valors dels filtres viuen a
  `attachmentList$` i es mantenen, i no es torna a demanar res al nucli.
- **Regió i nom:** la subfinestra és l'única regió «carpetes» d'F6 d'Adjunts, que
  passa a ser contingut, carpetes, mòduls. Es diu «Filtres d'adjunts», diferent de
  `<main>` («Adjunts») i de la resta de noms de regió i de panell, i de les
  etiquetes dels controls d'Adjunts, en els 20 catàlegs, com comprova una prova.
  Atès que els filtres ja no són dins del contingut, una llista buida deixa el
  contingut sense cap element on F6 pugui posar el focus, i F6 el salta, com al
  Xat sense cap conversa oberta; amb fitxers a la llista, F6 arriba fins al
  primer botó de la llista (o al darrer element que hi tenia el focus).
- **Per sota de 1025 px** la subfinestra no es mostra i la barra de filtres és
  exactament la d'abans, sota la capçalera, amb els noms accessibles i sense
  etiquetes visibles. Mai no són a dos llocs alhora.
- **Proves:** `frontend/src/components/attachments/AttachmentsFolderPane.test.tsx`
  (la regió i el seu nom; els cinc filtres, en ordre i amb etiqueta visible; el
  filtre de compte només amb més d'un compte; cada filtre canvia
  `attachmentList$.filter` i recarrega; l'amplada compartida i la base de 360 px;
  el nom diferent del de les altres regions en els 20 catàlegs; la barra a 1024 px
  i el pas de 1024 a 1025 px amb la mateixa llista i els mateixos valors) i
  `frontend/e2e/startup.e2e.ts` («#339»: la llista a 1025, 1100 i 1440 px amb la
  subfinestra a 200, 260 i 400 px, sense desplaçament horitzontal ni a la pàgina
  ni al cos de la subfinestra, amb cada control dins de la subfinestra; la barra a
  1024 px; filtrar des de la subfinestra, amb els valors i la llista mantinguts
  en travessar els 1025 px; l'amplada desada des d'Adjunts i des del correu;
  l'àrab, amb axe). El recorregut d'F6 de #306 hi afegeix Adjunts.

### El focus en travessar els 1025 px (#341)

Data: 2026-10-22. Des de 1025 px els controls de carpeta de cada mòdul són el cos
de la subfinestra comuna; per sota, són en un altre lloc (pestanyes, botons
d'etiqueta, la columna, la barra de filtres). Cada mòdul en munta només un dels
dos, de manera que el control que tenia el focus es desmuntava en travessar els
1025 px i el focus queia a `<body>`. Ara el focus segueix el control.

- **Funció auxiliar comuna:** `useFolderPaneFocus(inPane)`, a
  `frontend/src/components/shell/folderPaneFocus.ts`, al costat de `FolderPane`.
  Cada mòdul la crida just després de `useWideWindow(FOLDER_PANE_MIN_WINDOW)`.
- **Com s'assenyala:** un control que existeix en tots dos modes porta el mateix
  `data-focus-key` (`list:<id>`, `tag:<nom>`, `conversation:<jid>`,
  `filter-name`, `group-filter`…), i el contenidor que fa de subfinestra per sota
  de 1025 px porta `data-focus-return`.
- **Què fa:** cada cop que el focus entra en un control de la subfinestra o del
  contenidor de `data-focus-return`, en desa la clau. Després de cada clic torna
  a mirar on és el focus: un clic en una zona sense control el deixa a `<body>`,
  un segon clic al camp que ja té el focus no el mou i, en una pantalla tàctil,
  el focus canvia en aixecar el dit. Quan canvia el mode, després del pintat,
  enfoca el control del mode nou que té la mateixa clau; si no n'hi ha cap (una
  fila sense equivalent), enfoca el primer element enfocable de la regió que la
  substitueix: la subfinestra, en passar a ample, i el contenidor de
  `data-focus-return`, en passar a estret. No llegeix el focus en el moment del
  canvi perquè, quan arriba la consulta de mitjà, el navegador ja l'ha perdut.
- **Què no fa:** no fa res ni en el primer pintat, ni quan el focus era fora
  d'aquestes àrees, ni quan ha sobreviscut al canvi, i no toca el recorregut d'F6
  entre regions. Un focus que cau sol a `<body>` (un control que l'aplicació
  treu) no es detecta: en el canvi següent va al primer control de la regió que
  la substitueix, cosa que és millor que deixar-lo a `<body>`.
- **Mòduls:**
  - Tasques: fila de llista i pestanya; «Llista nova», «Canvia el nom» i
    «Suprimeix».
  - Notes: fila d'etiqueta i botó d'etiqueta; «Totes les notes» no té botó i va
    a la cerca.
  - Xat: tots els controls de la columna (el compte, el teu estat, les peticions
    per veure el teu estat i qui el pot veure, «Xateja amb (adreça)», el
    formulari d'«Uneix-te a un grup», les invitacions, les converses i «Elimina
    aquest compte de xat»). Es conserven l'estat sense desar, la llista de
    permisos oberta i les aturades demanades, perquè aquestes parts es tornen a
    muntar en canviar de lloc.
  - Adjunts: els cinc filtres.
  - Persones: el grup en pantalla i el selector de grup; les accions del grup.
  - Calendari: cada calendari, les fletxes i els dies del minicalendari.
  - El correu no la necessita: la subfinestra del correu no es desmunta (només
    s'amaga) i per sota de 1025 px no té cap control equivalent, sinó el
    selector «Canvia de carpeta».
- **Proves:** els `*FolderPane.test.tsx` de cada mòdul (focus en una fila, creuar
  els 1025 px en els dos sentits, el control equivalent o el primer element
  enfocable de la regió que el substitueix, i focus extern sense alterar) i
  `frontend/e2e/startup.e2e.ts` («#341»: el camp «Nom del fitxer» d'Adjunts i
  una fila de llista de Tasques, amb un canvi real de la mida de la finestra).
