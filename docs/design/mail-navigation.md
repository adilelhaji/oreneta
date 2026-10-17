# Navegació del correu en producció (#34)

Primera adopció de la [referència del correu](mail-reference.md), autoritzada per
la instrucció de l'usuari del 2026-09-09 d'integrar comptes i carpetes amb etiqueta.

- Un panell de navegació persistent de 220 px acompanya la barra de comptes
  existent en les visualitzacions del correu de més de 1024 píxels CSS d'amplada.
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
  arxiu local, POP3) com si són enllaços al pare (Microsoft Graph, Exchange).
- **Com es tornen a veure:** quan el compte obert té carpetes amagades,
  sota el quadre de filtre apareix «Mostra les carpetes amagades (N)», un
  botó commutador (`aria-pressed`). Activat, les carpetes amagades tornen a
  l'arbre amb una icona d'ull barrat i el text «Amagada» per al lector de
  pantalla, i el seu menú ofereix «Torna a mostrar la carpeta». Mostrar-les
  dura mentre el compte és obert: en canviar de compte, en reiniciar o quan
  ja no en queda cap d'amagada, torna a estar desactivat.
- **Només una preferència local:** les marques es desen a la preferència
  `folder_hidden` (compte + ruta de la carpeta al servidor), com les
  preferides i els colors (ADR-0050), i segueixen els mateixos casos: un
  moviment de carpeta les porta a la ruta nova, suprimir la carpeta o treure
  el compte se les emporta, i una carpeta desapareguda per un altre camí les
  perd sense avís (com els colors; l'avís és només per a les preferides). Cap
  servidor no se n'assabenta i el nucli no les llegeix: una carpeta amagada
  es continua sincronitzant exactament igual, i amagar o mostrar no envia
  res més que l'escriptura de la preferència.
- **Què no es pot amagar:** la Safata d'entrada, ni una carpeta que la
  contingui (és on s'obre cada compte). Una subcarpeta que ja queda amagada
  per la seva carpeta pare no s'amaga per separat; el menú ho diu.
- **On continuen visibles:** a Preferides, si la persona l'hi ha posat
  expressament; als selectors de destinació (moure missatges, moure
  carpetes, columnes del tauler, regles) i al selector de carpeta de la
  capçalera de la llista, que serveixen per triar una carpeta concreta.
- **Avisos i focus:** amagar o tornar a mostrar es diu per una regió
  `aria-live` («S'ha amagat Feina»). Si la fila amagada tenia el focus, el
  focus passa al commutador «Mostra les carpetes amagades».
- **Cerca:** la cerca busca a la carpeta oberta. «Opcions de cerca» diu
  on busca i si hi entren les carpetes amagades: amb una carpeta oberta, no
  (o que la mateixa carpeta oberta és amagada); a les carpetes unificades i a
  Destacats, que el nucli respon per a tots els comptes i carpetes, sí.
- **Fora d'abast:** l'aplicació mòbil, i desar les marques al servidor.
- **Proves:** `frontend/src/lib/folderHiding.test.ts` (què surt de l'arbre
  per ruta i per pare, què no es pot amagar, l'àmbit de la cerca),
  `frontend/src/states/folderPrefs.test.ts` (amagar, mostrar, desar, llegir
  en engegar i seguir moviments i supressions) i
  `frontend/src/components/sidenav/MailNavigation.test.tsx` (el menú, el
  commutador, el focus, la Safata d'entrada i Preferides).
