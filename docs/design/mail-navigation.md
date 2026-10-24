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
  tauler obert, la subfinestra no es mostra, com abans. Des de #353 (peça 14a)
  els taulers hi són, i la subfinestra es manté amb un tauler obert (vegeu
  [més avall](#el-que-feia-la-barra-vertical-353)), i des de #354 la barra vertical
  ja no hi és: els mòduls són la tira del peu de la subfinestra (vegeu
  [més avall](#la-tira-de-mòduls-i-la-barra-estreta-la-barra-vertical-sen-va-354)).
- **Regió i noms:** la subfinestra és el `<nav>` de la regió «carpetes» d'F6
  (`data-region="folders"`) i pren el nom de la seva fila de títol: «Comptes i
  carpetes», el mateix d'abans. El títol és un encapçalament de nivell 2, i
  «Preferits», «Comptes» i «Carpetes» passen a ser-ho de nivell 3. Mentre hi va
  haver la barra vertical (fins a #354), la subfinestra va continuar dins de
  `<main>`, just després de la barra. Des de #354 la barra no hi és, i la subfinestra
  continua dins de `<main>`, a l'inici de la fila, amb la tira de mòduls al peu.
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
  una llista desada de 560 px i la barra vertical de 60 px (fins a #354): a
  1200 px, carpetes de 220 px i la llista sencera; a 1100 i 1025 px, carpetes de
  200 px i una llista de 480 i 405 px. Sense la barra vertical (des de #354), la llista fa 540 i
  465 px a 1100 i 1025 px, i a 1140 px les carpetes en fan 220 (vegeu
  [més avall](#la-tira-de-mòduls-i-la-barra-estreta-la-barra-vertical-sen-va-354)).
- **Per sota de 1025 px** la subfinestra no es mostra, com la navegació d'abans,
  i el selector «Canvia de carpeta» de la llista dona accés a les carpetes.
- **Efecte en la barra lateral de detalls:** amb la barra vertical (fins a #354)
  i la subfinestra de 260 px (abans 220), la fila del lector feia 40 px menys. A
  1440 px, amb la llista per defecte, la barra lateral de detalls arribava com a
  màxim a 400 px al costat del lector (abans, 440). Des de #354, sense la barra
  vertical, la fila del lector té 60 px més, i la barra lateral de detalls hi
  arriba a 460 px. Que les carpetes i la llista
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
  `<main>`, just després de la barra vertical (fins a #354) i abans del mòdul. La
  capçalera del calendari (període, navegació, visualitzacions i «Esdeveniment nou») queda a la
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
  que la subfinestra no ha de cedir. Amb la barra vertical de 60 px (fins a
  #354), al mòdul li quedaven 765 px amb la subfinestra al mínim (200 px), 705 px
  amb la de per defecte (260 px) i 565 px amb la màxima (400 px). El dia, la setmana i el mes
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
  nou» i l'avís de possibles duplicats) i la llista de persones continuen al
  mòdul, en una columna de 288 px al costat de la subfinestra (18 rem per sota
  de 1025 px), i els detalls de la persona al seu costat. És el que l'ADR
  anomena la llista, no les carpetes. La cerca, que també era a la capçalera,
  és a la banda superior des de #344 ([top-band.md](top-band.md#la-cerca-344)).
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 de Persones i es diu
  «Grups de contactes» (`people.contactGroups`), una cadena pròpia de l'escriptori
  i diferent de `<main>` («Persones») i de «Grups» (el títol d'una secció de la
  fitxa, `people.groups`) en els 20 catàlegs, com comprova una prova. Abans, la
  regió «carpetes» era la columna de la llista, una `<section>` sense nom: ara és
  la subfinestra, que és a `<main>`, just després de la barra vertical (fins a
  #354) i abans del mòdul, i la llista és només el contingut. Abans de #354, F6
  anava de la barra vertical al mòdul, a la subfinestra i altre cop a la barra.
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
  barra vertical de 60 px (fins a #354) i la llista de 288 px, la fitxa tenia
  477 px amb la subfinestra al mínim (200 px) i 417 px amb la de per defecte
  (260 px); amb la màxima (400 px) la subfinestra es pintava a 317 px i la fitxa
  en tenia 360. Cap control no surt del mòdul i no hi ha desplaçament
  horitzontal. Al 200 % de l'aplicació a 1025 px la barra vertical feia 120 px, la
  subfinestra per defecte cedia fins a uns 257 px i la fitxa en conservava uns 360.
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
  capçalera (títol, «Mostra les completades», «Tasca nova»). La cerca, que
  quedava a la barra de sota la capçalera, és a la banda superior des de #344
  ([top-band.md](top-band.md#la-cerca-344)); a partir de 1025 px ja no hi ha
  aquesta barra, i per sota hi queden les pestanyes. Tasques
  no té cap filtre d'estat a part de «Mostra les completades», ni reordenació de
  llistes, ni arrossegar i deixar anar, ni menús contextuals a les pestanyes, de
  manera que no se n'ha hagut de moure cap.
- **Regió i nom:** la subfinestra és la regió «carpetes» d'F6 de Tasques i es
  diu «Llistes de tasques» (`tasks.taskLists`), una cadena pròpia de
  l'escriptori i diferent de `<main>` («Tasques») en els 20 catàlegs, com
  comprova una prova. Abans Tasques no tenia cap regió «carpetes». Abans de
  #354, F6 anava de la barra vertical al mòdul, a la subfinestra i altre cop a la
  barra.
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
- **Què queda a la llista:** «Paperera» i «Nota nova» a la capçalera, la
  llista de notes i l'editor. La cerca, que era a dalt de la llista, és a la
  banda superior des de #344 ([top-band.md](top-band.md#la-cerca-344)); per
  sota de 1025 px, a dalt de la llista només hi ha els botons d'etiqueta, i
  només si n'hi ha. La columna de la llista és de 320 px (20 rem a
  1024 px i menys) i el mòdul demana 680 px com a base (la llista i els 360 px de
  la nota, el mínim del lector d'ADR-0068 §7): la subfinestra, que cedeix abans
  que res, s'encongeix fins a donar-los-hi. A 1025 px, amb la barra vertical de
  60 px (fins a #354), la subfinestra de 400 px es pintava a uns 285 px.
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
- **Des de #344**, el nom del fitxer es cerca des de la banda superior («Cerca
  adjunts pel nom del fitxer», [top-band.md](top-band.md#la-cerca-344)), amb el
  mateix estat i el mateix retard. La subfinestra i, per sota de 1025 px, la barra
  tenen els altres quatre filtres: remitent, tipus, quan i compte. La clau
  `attachmentsView.searchName` («Nom del fitxer») ha sortit dels catàlegs.
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
  `filter-sender`, `group-filter`…), i el contenidor que fa de subfinestra per sota
  de 1025 px porta `data-focus-return`. `filter-name`, el nom del fitxer
  d'Adjunts, se'n va amb #344, perquè el camp passa a la banda superior. A Notes,
  des de #344, el contenidor de `data-focus-return` és la columna de la llista
  sencera, i no la zona de la cerca i els botons d'etiqueta.
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
    al primer control de la columna de la llista: el primer botó d'etiqueta o, si
    no n'hi ha cap, la primera nota. Abans anava a la cerca, que des de #344 és a
    la banda superior.
  - Xat: tots els controls de la columna (el compte, el teu estat, les peticions
    per veure el teu estat i qui el pot veure, «Xateja amb (adreça)», el
    formulari d'«Uneix-te a un grup», les invitacions, les converses i «Elimina
    aquest compte de xat»). Es conserven l'estat sense desar, la llista de
    permisos oberta i les aturades demanades, perquè aquestes parts es tornen a
    muntar en canviar de lloc.
  - Adjunts: els filtres. Des de #344 són quatre: el nom del fitxer es cerca des
    de la banda superior, que no es mou i conserva el focus.
  - Persones: el grup en pantalla i el selector de grup; les accions del grup.
  - Calendari: cada calendari, les fletxes i els dies del minicalendari.
  - El correu no la necessita: la subfinestra del correu no es desmunta (només
    s'amaga) i per sota de 1025 px no té cap control equivalent, sinó el
    selector «Canvia de carpeta».
- **Proves:** els `*FolderPane.test.tsx` de cada mòdul (focus en una fila, creuar
  els 1025 px en els dos sentits, el control equivalent o el primer element
  enfocable de la regió que el substitueix, i focus extern sense alterar) i
  `frontend/e2e/startup.e2e.ts` («#341»: el camp «De» d'Adjunts, que des de #344
  substitueix el de «Nom del fitxer», i una fila de llista de Tasques, amb un
  canvi real de la mida de la finestra).

## El que feia la barra vertical (#353)

Data: 2026-10-23. Peça 14a, la primera part del pas 4 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§4 i §5, «El que hi havia a
la barra vertical»), amb les decisions del propietari de #352. La subfinestra de
carpetes del correu, «Comptes i carpetes», va passar a fer el que només feia la
barra vertical amb els comptes, els taulers i la safata d'entrada unificada. La barra
vertical encara hi era i feia el mateix que abans: compartia amb la subfinestra el
codi, l'ordre i els menús, i se'n va anar a la peça 14b (#354), amb el selector de
mòduls (vegeu [més avall](#la-tira-de-mòduls-i-la-barra-estreta-la-barra-vertical-sen-va-354)).

- **Ordre del cos:** Preferits; «Comptes», amb la safata d'entrada unificada,
  «Taulers», els grups de comptes i els comptes; «Carpetes». Era l'ordre de la
  barra vertical i el de Ctrl/⌘+1…9 (la safata unificada, si es mostra; els
  taulers; els comptes visibles), que no canvien. La safata unificada continua
  sent la primera fila de «Comptes». «Taulers» no és cap títol (ni cap regió):
  és un grup amb nom (`role="group"`, amb l'etiqueta visible «Taulers»), entre
  la safata unificada i els grups, com demana ADR-0068. Així, qui va de títol en
  títol troba la safata, els taulers, els grups i els comptes sota «Comptes», i
  no sota «Preferits» ni sota un títol que no és el seu.
- **Ordenar els comptes:** arrossegant-los amb el punter (dnd-kit, com a la
  barra vertical) o, amb el focus en un compte, amb Alt+↑ i Alt+↓, que el mouen
  una posició, com les preferides (ADR-0050): el focus s'hi queda i la regió
  `aria-live` de la subfinestra en diu la posició nova («Alex s'ha mogut a la
  posició 2 de 3»). Retorn i Espai continuen obrint el compte: a la barra
  vertical començaven un arrossegament, perquè allà la fila no era un botó, però a
  la subfinestra les files ja eren botons. Mentre el punter arrossega una fila,
  dnd-kit ho anuncia en l'idioma de la interfície (la barra vertical ho deia en
  anglès i amb l'identificador del compte), i Esc ho cancel·la. És l'ordre desat
  (`account.reorder`), el que feia servir la barra vertical. Els comptes amagats hi conserven
  el seu lloc i només es mouen els que es veuen; el càlcul
  (`shownAccountOrder`, a `states/accounts.ts`) era el mateix per a totes dues.
  Una llista d'un sol compte, o d'un sol tauler, no s'ordena.
- **Menú contextual del compte:** el de la barra vertical
  (`AccountContextMenu`): configuració del compte, marcar-ho tot com a llegit
  (desactivat sense no llegits o en un compte de Microsoft Graph), silenciar les
  notificacions, posar la comprovació en pausa o reprendre-la, i amagar el
  compte. S'obre amb el clic dret, Maj+F10 i la tecla de menú, com el de les
  carpetes, i en tancar-se el focus torna a la fila. L'element d'amagar diu
  «Amaga el compte» (`mailNavigation.actions.hideAccount`), sense parlar de la
  navegació lateral; la barra vertical va conservar el seu text fins a #354.
  Amagar fa servir la mateixa preferència, `hidden_sidenav_accounts`: el compte
  surt de la subfinestra, de Ctrl/⌘+1…9 i, fins a #354, de la barra vertical, i es torna a
  mostrar des de Configuració. El focus passa a la fila que ocupa el seu lloc i
  la regió `aria-live` ho diu («S'ha amagat Alex. Es pot tornar a mostrar des de
  Configuració.»). El compte obert continua a la subfinestra, com abans, i
  conserva el focus; com que la fila no se n'ha anat, no es diu res. Amb la
  safata unificada passa el mateix.
- **Comptador:** els no llegits de la safata d'entrada del compte, al final de
  la fila, com a les carpetes, només quan «Mostra el comptador de no llegits»
  (`showUnreadAccountBadge`) està activat, com feia la barra vertical.
- **Estat del compte:** un compte que ha de tornar a iniciar la sessió, en pausa
  o silenciat porta una icona (una clau, una pausa o una campana barrada, del
  color del text secundari, que a totes les superfícies compleix el contrast) i
  les paraules, que el lector de pantalla llegeix amb el nom del compte: «Cal
  tornar a iniciar la sessió» (`mailNavigation.status.reconnect`),
  «Comprovacions del correu en pausa» (`connectivity.health.paused`, el text de
  l'estat de la sincronització) i «Notificacions silenciades»
  (`mailNavigation.status.muted`). Només se'n diu un, el més urgent, com a la barra
  vertical, i la indicació també el diu.
- **Canals RSS:** la fila d'un compte RSS accepta un canal que s'hi arrossega
  des de la llista d'un altre compte RSS i l'hi mou (`moveFeed`), amb els seus
  elements i el seu estat de lectura; mentre el canal és al damunt, la fila es marca amb la
  vora discontínua de deixar anar. Mentre s'arrossega, el navegador només deixa
  veure el tipus del que s'arrossega, no el contingut: la barra vertical el volia
  llegir i a Chromium, que és el motor de WebView2, no acceptava mai el canal.
  Ara totes dues el reconeixen pel tipus, i la llista coneix el compte d'on ve,
  perquè el desa en començar l'arrossegament i l'oblida en acabar-lo
  (`states/feeds.ts`): sobre aquest compte el canal no s'accepta i la fila no es
  marca (`sidenav/accountNav.ts`).
- **«Taulers»:** un grup amb l'etiqueta «Taulers» (`mailNavigation.boards`),
  dins de «Comptes», entre la safata unificada i els grups de comptes, amb els
  taulers kanban en el seu ordre, cadascun amb la seva imatge o, si no en té, la
  icona de columnes. Un clic, Retorn o Espai obren el tauler com la barra
  vertical (`openKanbanBoard`). S'ordenen com els comptes (el punter, Alt+↑ i
  Alt+↓) amb `reorderKanbanBoards`, i tenen el menú de la barra vertical
  (`BoardContextMenu`: configuració i supressió), també amb Maj+F10 i la tecla
  de menú. Quan se'n suprimeix un des del menú, el focus passa al tauler
  següent o, si no n'hi ha, a l'anterior; si era l'últim, al tauler buit nou que
  n'ocupa el lloc. Sense cap tauler, el grup no hi és; «Crea un tauler kanban»
  continua al menú de l'aplicació.
- **Amb un tauler obert,** la subfinestra es continua mostrant, com demana
  ADR-0068 §4 (abans s'amagava), i hi marca el tauler (`aria-current`), no el
  compte ni la carpeta on era el correu. Un compte, una carpeta, una preferida,
  la safata unificada o un grup tornen al correu; el compte on era el correu hi
  torna a la carpeta que mostrava, com feia la barra vertical.
- **La subfinestra de conversa del tauler** és un percentatge de l'àrea del
  tauler (la fila menys les carpetes i, fins a #354, la barra vertical), amb els límits d'abans
  (del 25 al 60 %); abans ho era de la fila sencera. El percentatge que es
  recorda (`kanban_pane_width`) no canvia de valor, però ara és una part d'aquesta
  àrea, de manera que el mateix valor fa la subfinestra de conversa una mica més estreta. A partir de
  769 px no es mostra mai més estreta que els 360 px del lector que hi ha a dins
  (abans, 320 px, i el lector, que en conserva 360, en quedava tallat, amb
  «Envia» fora de la pantalla); per sota, en conserva 320. L'àrea necessita una
  columna de l'amplada triada més els 360 px del lector: on la fila no hi arriba,
  les carpetes cedeixen fins al seu mínim abans que les columnes, com al costat
  de la llista de converses. A 1025 px, amb les carpetes a 260 o 400 px, les
  carpetes queden a uns 245 px, i el tauler i la conversa, a 360 px cadascun. El
  separador «Canvia la mida de la conversa» desapareix només quan la finestra fa
  menys de 600 px (llavors la conversa ocupa tota l'amplada) o quan a l'àrea no
  queda res per triar, no quan l'àrea fa menys de 600 px.
- **Safata d'entrada unificada:** la fila té el menú contextual de la barra
  vertical, que ara comparteixen (`UnifiedInboxContextMenu`): «Mostra {nom}
  conjuntament» per a cada grup de comptes i «Amaga la safata d'entrada
  unificada» (`mailNavigation.actions.hideUnified`), amb la preferència
  `show_unified_inbox_in_sidenav`. S'obre amb el clic dret, Maj+F10 i la tecla
  de menú. El seu comptador va quedar a la barra vertical fins a la peça 14b; des
  de #354 és al botó Correu de la tira de mòduls (decisió 2 del propietari a #352).
- **Sense canvis:** les preferències `show_unified_inbox_in_sidenav` i
  `hidden_sidenav_accounts` (la clau i l'efecte), la seqüència de Ctrl/⌘+1…9,
  l'arbre de carpetes, les preferides i els grups. Els textos de Configuració
  que parlen de la navegació lateral («Mostra a la navegació lateral» i la
  indicació del comptador) van canviar a la peça 14b, quan la barra se'n va anar.
- **Amplada, zoom i dreta a esquerra:** els noms acaben en «…» i la indicació
  els mostra sencers; el comptador, l'estat i la imatge del tauler conserven la
  mida. Tot és en propietats lògiques. Per sota de 1025 px la subfinestra no es
  mostra, com abans; com que no es desmunta i a fora no hi ha cap control
  equivalent (#341), les files noves no porten `data-focus-key`.
- **Textos nous,** als 20 catàlegs: «Taulers» (`mailNavigation.boards`),
  «Amaga el compte», «Amaga la safata d'entrada unificada», «Cal tornar a
  iniciar la sessió», «Notificacions silenciades», «{name} s'ha mogut a la
  posició {position} de {count}» (`mailNavigation.moved`), «S'està movent
  {name}.» i «{name} es queda on era.» (`mailNavigation.drag.*`, els anuncis de
  l'arrossegament) i «S'ha amagat {name}. Es pot tornar a mostrar des de
  Configuració.» (`mailNavigation.hidden`).
- **Proves:** `frontend/src/components/sidenav/MailNavigationDestinations.test.tsx`
  (ordenar els comptes amb Alt+↑ i Alt+↓, el focus i l'anunci; el mateix ordre que tenia
  aleshores la barra vertical, amb els comptes amagats al seu lloc; el menú amb el ratolí,
  Maj+F10 i la tecla de menú, i amagar; el comptador segons la preferència;
  l'estat en paraules; deixar-hi anar un canal, i que el compte d'on ve no
  l'accepti; el grup «Taulers»: llistar, ordenar, obrir, marcar el tauler obert,
  el menú, el focus en suprimir-ne un i que no hi sigui sense taulers; el menú de
  la safata unificada; i les posicions de Ctrl/⌘+1…9),
  `frontend/src/lib/paneResize.test.ts` (el mínim de 360 px de la subfinestra
  de conversa del tauler, i 320 per sota de 769 px, i el que demana l'àrea) i
  `frontend/e2e/startup.e2e.ts` («#353», a 1440 px: ordenar els comptes amb el
  teclat i el punter, amb la barra vertical d'aleshores en el mateix ordre; el menú del
  compte amb el ratolí, Maj+F10 i la tecla de menú, i amagar-lo; obrir un tauler
  des de la subfinestra, que s'hi queda, amb el ratolí i el teclat, i el seu
  menú; suprimir un tauler des del seu menú, amb el focus al següent; deixar
  anar un canal de la llista en un altre compte RSS, rebutjat sobre el seu; el
  menú de la safata unificada; en àrab, l'estat i el menú en el
  sentit de lectura, axe amb el menú obert i el 200 % de l'aplicació sense
  desplaçament horitzontal; i, a 1025 px amb les carpetes a 260 i 400 px i a
  1280 px, un missatge nou al costat d'un tauler sencer, amb «Envia» dins de la
  subfinestra, el separador i les columnes amb una columna sencera).

## La tira de mòduls i la barra estreta: la barra vertical se'n va (#354)

Data: 2026-10-24. Peça 14b, la segona part del pas 4 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §5, §7 i §8), amb les
decisions del propietari de [#352](https://github.com/adilelhaji/oreneta/issues/352).
La barra vertical (`SideNav`) se'n va: el que només feia ella amb els comptes, els
taulers i la safata d'entrada unificada ja era a «Comptes i carpetes» des de #353
([més amunt](#el-que-feia-la-barra-vertical-353)), i els mòduls passen al selector
de mòduls, que té dues formes.

Codi: `frontend/src/components/shell/ModuleSwitcher.tsx` (el selector, la mesura,
«Més», el teclat i el focus), `components/shell/moduleLayout.ts` (l'ordre, els
noms i què hi cap), `components/shell/FolderPane.tsx` (la tira al peu),
`App.tsx` (la barra estreta), `states/mail.ts` (`unifiedInboxUnread`),
`states/messaging.ts` (`chatUnread`), `useAppEffects.ts` (el xat llegit en
arrencar) i `index.css` (els colors de la barra estreta).

- **La tira de mòduls:** a partir de 1025 px, al peu de la subfinestra de carpetes
  de cada mòdul, sota el cos i el peu (al Calendari, el calendari petit), de
  2,5 rem d'alçada i del color de la subfinestra. El cos es desplaça per damunt del
  peu i de la tira, que no es mouen.
- **La barra estreta:** entre 769 i 1024 px, on la subfinestra no es pinta, una
  barra vertical d'icones de 3 rem a l'inici de la fila, amb els mateixos botons,
  els mateixos comptadors i el mateix «Més», sense comptes ni taulers. El selector
  «Canvia de carpeta» de la llista continua donant accés a les carpetes i als
  comptes.
- **Per sota de 769 px** no hi ha ni tira ni barra: els mòduls s'obren des del
  menú de l'aplicació (un «Ves a: …» per a cada mòdul), i cada mòdul conserva la
  fletxa per tornar al correu (`CompactNavigation`).
- **Regió i nom:** totes dues formes són el `<nav>` «Mòduls»
  (`shell.region.modules`), la regió `modules` d'F6, que substitueix l'`<aside>`
  de la barra vertical. Només se'n munta una alhora (la tira mentre la subfinestra
  es pinta, la barra de 769 a 1024 px), de manera que el nom no es repeteix. A la
  tira, la regió és dins de la regió «carpetes»; F6 hi arriba després de les
  carpetes, en l'ordre de `REGION_ORDER`, que no canvia, i els botons de la tira
  no compten per a les carpetes.
- **Botons:** Correu, Calendari, Persones, Tasques, Notes, Xat i Adjunts, en
  aquest ordre (el de `ui$.module`) i en una llista. Són icones de Lucide sense
  text; el nom del mòdul, el mateix que pren `<main>`, és la indicació (`title`) i
  el nom accessible, de manera que `getByTitle('People')` els continua trobant.
  L'actiu porta `aria-current="page"`, el fons de selecció (`bg-active`), la icona
  en l'accent com a text i una barra d'accent (`accent-fg`): a la vora superior a
  la tira i a la vora inicial a la barra estreta, que és vertical. Un botó obre el
  seu mòdul o, si ja està obert, torna al correu, com feien els de la barra
  vertical (`toggleModule`).
- **Comptadors** (decisió 2 del propietari a #352): el Correu mostra el de la
  safata d'entrada unificada, la suma dels no llegits de la safata d'entrada dels
  comptes que hi entren (`included_in_unified` diferent de `false`), el número que mostrava el
  botó de la safata unificada de la barra vertical, i només mentre «Mostra el
  comptador de no llegits» està activat. El Xat mostra els seus: els no llegits de
  les converses directes i dels grups del compte de xat obert, també dels
  silenciats, que continuen comptant com a no llegits (decisió del propietari a
  #352: només el compte de xat obert). Perquè el del Xat sigui cert des de l'inici,
  el xat es llegeix quan hi ha el primer compte (`loadMessaging`), i no només en
  obrir el Xat; després el manté `chat.changed`. La conversa oberta continua oberta
  quan es va a un altre mòdul, perquè hi sigui en tornar, però només és a la
  pantalla mentre s'hi veu el Xat: un missatge que hi arriba mentrestant compta com
  a no llegit al botó del Xat (abans es marcava com a llegit sense que ningú el
  veiés), i es marca com a llegit en tornar al Xat, si la conversa encara està
  oberta. El número es pinta sobre
  la icona (com a màxim «99+») i es diu en paraules com a descripció del botó
  («3 no llegits», `reading.unread`); el nom continua sent el del mòdul.
- **El que no hi cap va a «Més»** (`common.more`): un `ResizeObserver` mesura
  quants llocs hi ha al llarg de la tira, o de dalt a baix de la barra, amb un lloc
  per a «Més», i els mòduls que no hi caben hi van en l'ordre de la tira, cadascun
  amb el seu comptador. El mòdul actiu no hi va mai: ocupa l'últim dels llocs que es
  veuen. «Més» és un menú de la primitiva de la peça 7 (`MenuList`), amb el focus al
  primer element en obrir-se; s'obre damunt de la tira, cap a l'inici de la línia, o
  al costat de la barra, cap amunt, sempre dins de la finestra. Els llocs fan 2 rem
  a la tira i 3 rem a la barra: al 100 % hi caben els set en una subfinestra de
  260 px, i cinc i «Més» en una de 200 px; al 200 % de l'aplicació, dos i «Més» en
  260 px. La barra estreta, al 200 % a 1024 px, té lloc per als set en una finestra
  de 1000 px d'alçada, i per a quatre i «Més» en una de 600 px.
- **Teclat:** cada botó, «Més» inclòs, és una parada de Tab, com les pestanyes
  d'ADR-0061. Les fletxes laterals els recorren en cercle en el sentit de lectura
  (en àrab, la fletxa esquerra va endavant), i Inici i Fi van als extrems; a la barra
  estreta, també Amunt i Avall. Les fletxes només mouen el focus: Retorn o Espai
  obren el mòdul. Les tecles que el selector respon no arriben a les dreceres de
  l'aplicació (`AppHotkeys`); Amunt i Avall a la tira sí, com feien a la barra
  vertical.
- **Focus:** cada mòdul pinta la seva subfinestra, de manera que, en obrir un mòdul
  des de la tira, se'n pinta una de nova i el focus aniria a la pàgina: la tira nova
  el posa al botó que s'ha premut. Un mòdul triat a «Més» passa a ocupar l'últim
  lloc i el focus va al seu botó. Si el botó que té el focus passa a «Més» perquè
  la tira s'estreny (la subfinestra, la finestra o el zoom), el focus va a «Més».
  La tira nova es pinta primer amb tots els botons i després es mesura: el focus
  espera la mesura, de manera que, en tornar al correu des d'un mòdul que és a
  «Més» (al 200 %, en una subfinestra de 260 px), va a «Més» i no a la pàgina. Si
  «Més» es buida amb el seu menú obert (la tira s'eixampla), el menú es tanca i el
  focus va a l'últim botó. Quan la finestra travessa els 1025 px amb el focus al
  selector, la tira i la barra estreta, que són elements diferents, es passen el
  focus: el botó del mateix mòdul el pren a l'altra forma, o «Més» si el mòdul hi
  és, en qualsevol mòdul, el correu inclòs. Com que el navegador pot haver deixat
  anar el focus abans (la subfinestra s'amaga per CSS en aquell moment), el
  selector el segueix mentre es mou, com fa `folderPaneFocus.ts` amb els controls
  de la subfinestra, que des d'ara deixa la tira al selector. Un mòdul obert des
  d'un altre lloc (el menú de l'aplicació, la paleta) no mou el focus; el selector
  no el pren a una ordre que l'ha posat en un altre lloc (com «Cerca a tots els
  missatges», que el posa a la cerca de la banda), i un selector que es pinta més
  tard no el pren mai.
- **Colors** (decisió 4 del propietari a #352): el color del tema «Barra de
  mòduls» (`--me-bg-sidenav`, abans «Navegació lateral»; el token conserva el nom,
  i els temes personalitzats desats, el seu valor) només pinta la barra estreta; la
  tira pren el de la subfinestra. Les icones i l'anell de focus de la barra estreta
  prenen l'extrem clar de la paleta: el to del marc als temes clars i el text
  principal als foscos, a 10:1 o més en els 16 temes integrats (a 6,85:1 o més
  sota el to del pas del punter). L'anell de la barra vertical, el farciment de l'accent, hi
  quedava a 2,03:1 a Oreneta Light (vegeu [design-system.md](design-system.md)).
  L'editor de temes personalitzats avisa, com fa amb el text i l'accent, quan les
  icones de la barra estreta no arriben a 4,5:1 sobre el color triat
  (`contrastShortfalls`, amb l'aspecte del tema), sense impedir desar-lo. La
  franja `MacTitleBar` de macOS, que també feia servir aquest color, pren el de la
  banda superior.
- **El Xat sense cap compte de xat** (`ChatSetup`) no tenia subfinestra: a partir de
  1025 px en té una, «Converses», perquè la tira hi sigui, sense res més que la
  línia «Encara no hi ha res» (`empty.nothingHereYet`); el formulari no canvia, i
  per sota de 1025 px tot és com abans. Sense això, el Xat seria l'únic
  mòdul sense cap camí cap als altres fora del menú de l'aplicació.
- **El que feia la barra vertical i on és ara:**
  - els comptes, els taulers i la safata d'entrada unificada, amb els seus menús i
    el seu ordre: a «Comptes i carpetes», des de #353;
  - el menú «Més» (els mòduls, la paleta, afegir un compte, afegir un tauler,
    sincronitzar, el mode No molestis, la configuració i «Quant a»): al menú de
    l'aplicació, que els té des de #343 ([top-band.md](top-band.md)). «Sincronitza
    la bústia» hi espera mentre hi ha una comprovació en curs, desactivada i amb el
    motiu («S'està sol·licitant una comprovació del correu…»), com feia el menú
    «Més». Afegir un tauler el crea de seguida amb el nom per defecte, sense el
    diàleg del nom de la barra vertical, com ja feia la paleta (decisió del
    propietari a #352, a tot arreu); el diàleg (`BoardDialog`) se'n va;
  - el clic dret sobre la barra buida, que obria el menú «Més»: el mateix contingut,
    des del botó del menú de l'aplicació;
  - l'indicador del mode No molestis: a la banda superior des de #345, i ara és
    l'únic;
  - els mòduls: a la tira de mòduls i a la barra estreta.

  El menú «Més» de per sota de 769 px, a `CompactNavigation` i a la capçalera de la
  llista estreta, i `QuickSettingsMenu` també se'n van (decisió 3 del propietari a
  #352); la fletxa per tornar al correu es manté.
- **Configuració:** els textos ja no parlen de la navegació lateral. El grup de la
  safata unificada es diu «Comptes i carpetes» (`mailNavigation.title`); la
  casella de cada compte, «Mostra a “Comptes i carpetes”»
  (`settings.account.showInMailNavigation`); i la indicació del comptador, «Mostra
  els no llegits de la safata d'entrada de cada compte a “Comptes i carpetes”, i els
  de la safata d'entrada unificada al botó Correu»
  (`settings.appearance.unreadBadgeHint`). Les claus d'abans continuen al catàleg,
  sense canvis, perquè les fa servir l'aplicació mòbil, que sí que té una navegació
  lateral (ADR-0068 la deixa fora d'abast). `sidenav.actions.hideFromSideNav` i
  `sidenav.actions.viewAndTheme`, que ja no feia servir cap component, surten dels
  catàlegs, i `kanban.actions.addBoardShort`, el botó del diàleg del nom, també.
  Les claus de les preferències (`show_unified_inbox_in_sidenav` i
  `hidden_sidenav_accounts`) no canvien, i no cal cap migració.
- **Ctrl/⌘+1…9 no canvien:** la safata unificada si es mostra, els taulers i els
  comptes visibles, en l'ordre de «Comptes i carpetes»; canvien el lloc del correu
  sense canviar el mòdul en pantalla, com abans, i els mòduls no tenen drecera. Al
  diàleg de les dreceres de teclat, el grup «Side navigation» es diu «Accounts and
  folders» (aquests noms encara no són al catàleg de traduccions).
- **Espai:** a partir de 1025 px la fila guanya els 60 px de la barra vertical.
  Amb una llista desada de 560 px, a 1025 px les carpetes fan 200 px i la llista
  465 px (abans, 405); a 1100 px, 200 i 540 px (abans, 480); a 1140 px, 220 px i la
  llista sencera; a 1200 px, també la subfinestra sencera. A Persones, a 1025 px, la
  fitxa té 537, 477 i 360 px amb la subfinestra a 200, 260 i 400 px; la de 400 px es
  pinta a 377 px. Entre 769 i 1024 px la barra estreta fa 48 px, 12 menys que la
  barra vertical.
- **Pendent:** la subfinestra de carpetes, i amb ella la tira, continua dins de
  `<main>`, perquè la pinta cada mòdul; la barra estreta hi és al lloc de la barra
  vertical. ADR-0068 §1 vol que `<main>` només contingui el mòdul: treure-les-en és
  un pas propi.
- **Textos nous,** als 20 catàlegs: «Mostra a “Comptes i carpetes”»
  (`settings.account.showInMailNavigation`), la indicació del comptador
  (`settings.appearance.unreadBadgeHint`) i l'avís de l'editor de temes «Les
  icones es llegeixen malament sobre la barra de mòduls ({ratio}:1; cal com a
  mínim 4,5:1).» (`theme.lowContrast.moduleBar`). Canvien, també als 20: «Barra de mòduls»
  (`theme.fields.sideNav`, abans «Navegació lateral») i «La barra d'icones dels
  mòduls en una finestra d'amplada mitjana» (`theme.fields.sideNavHint`, abans «La
  navegació de comptes de l'esquerra»).
- **Proves:** `frontend/src/components/shell/moduleLayout.test.ts` (els llocs, què
  va a «Més» i en quin ordre, l'actiu mai, el mínim d'un botó),
  `components/shell/ModuleSwitcher.test.tsx` (la regió i els noms, en català també i
  diferents en els 20 catàlegs; l'actiu i la seva barra d'accent a la tira i a la barra;
  obrir i tornar; els comptadors del Correu, amb la preferència i el màxim, i del Xat;
  «Més» amb una amplada simulada, a 260 px al 100 % i al 200 % i a la barra; l'actiu
  mai a «Més»; el focus quan el botó hi passa, quan la tira es torna a pintar, en
  tornar al correu des d'un mòdul que és a «Més», quan «Més» es buida amb el
  menú obert i quan la tira i la barra es passen el lloc, tant si es pinten alhora
  com l'una després de l'altra, sense prendre'l a una ordre que l'ha posat en un
  altre lloc; el menú, que no torna a subscriure's als
  esdeveniments cada vegada que es pinta; el teclat d'esquerra a dreta i de dreta a
  esquerra, i les tecles que deixa passar),
  `components/messaging/MessagingView.test.tsx` (el missatge que arriba a la
  conversa oberta mentre no es veu el Xat, i el retorn),
  `useAppEffects.test.tsx` (el xat es llegeix en arrencar, quan hi ha un compte, i
  només una vegada),
  `components/dialog/ThemeEditorDialog.test.tsx` i `lib/themes.test.ts` (l'avís de
  la barra de mòduls),
  `components/shell/FolderPane.test.tsx` (la tira al peu, només a partir de 1025 px),
  els `*FolderPane.test.tsx` de cada mòdul (la tira és l'única regió dins de la
  subfinestra; el Xat sense compte, amb la subfinestra buida),
  `components/sidenav/MailNavigationDestinations.test.tsx` (l'ordre compartit amb
  Ctrl/⌘+1…9, i Ctrl/⌘+1…9 des d'un altre mòdul, sense obrir cap mòdul),
  `components/sidenav/CompactNavigation.test.tsx`,
  `components/sidenav/QuietIndicator.test.tsx` i
  `baseline/manualRefreshUi.test.tsx` (el menú de l'aplicació en lloc del menú
  «Més»), `lib/regions.test.ts` (la tira dins de les carpetes i la barra estreta
  sola) i `lib/themes.test.ts` (les icones, el pas del punter, l'actiu i l'anell de
  la barra estreta en els 16 temes) i `frontend/e2e/startup.e2e.ts` («#354»: la tira,
  la barra estreta i el menú compacte a 1025, 1024, 769 i 768 px, amb el color de
  cada una, els comptadors, el teclat i el focus; el desbordament de la tira al 200 %
  a 1440 i 1025 px; el focus a «Més» en tornar al correu al 200 %; el focus al
  mateix botó de 1440 a 1000 px i tornant a 1440, al correu i a Notes; la barra estreta al 200 % a 1024 px, sense desplaçament
  horitzontal; el teclat en català i en àrab; les regles de regions d'axe i les WCAG
  a 1440, 1024 i 768 px i al 200 % amb «Més» obert). Les proves que trobaven la barra
  vertical (`main > aside`, el `complementary` «Mòduls», el seu menú «Més» i el
  seu indicador del mode No molestis) busquen ara el `<nav>` «Mòduls», el menú de
  l'aplicació i la banda; les que calculaven l'espai amb els 60 px de la barra, la
  fila sense, de manera que les amplades que esperen guanyen aquests 60 px; i les
  de Xat i Adjunts amb la subfinestra a 200 px els obren des de «Més». A la taula
  de #317, la llista passa de 405 a 465 px a 1025 px i de 480 a 540 px a 1100 px,
  les carpetes fan els 260 px sencers a 1200 px (abans, 220), i hi ha una fila nova
  a 1140 px, la primera amplada amb la llista sencera i les carpetes a 220 px. La
  resta de les proves de límits, de zoom, de dreta a esquerra i d'axe es mantenen
  amb les mateixes expectatives.
