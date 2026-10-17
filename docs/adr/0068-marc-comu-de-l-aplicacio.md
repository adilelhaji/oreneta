# ADR-0068: Marc comú de l'aplicació: banda superior, barra d'eines, subfinestra de carpetes i selector de mòduls

- Estat: proposada. Cal que el propietari l'accepti abans d'escriure'n el codi.
  El 2026-10-17 el propietari va aprovar la proposta de redisseny («Lo
  apruebo»), amb les decisions D1 (selector de mòduls com a tira al peu de la
  subfinestra de carpetes, en lloc de la barra vertical) i D7 (banda superior
  dins de la finestra, sota la barra de títol nativa, sense finestra sense
  marc); aquesta ADR concreta com es fa i no és encara acceptada.
- Data: 2026-10-17.
- Abast: #288, peces 10 (subfinestra de carpetes comuna), 13 (banda
  superior) i 14 (selector de mòduls) de la proposta de redisseny. Sobre
  ADR-0059 (separadors), ADR-0061 (dreta a esquerra) i ADR-0062 (català), i
  sobre els límits de [mail-boundaries.md](../design/mail-boundaries.md) i el
  zoom de [keyboard-zoom.md](../design/keyboard-zoom.md). La barra lateral
  dreta és a ADR-0069; els colors, els radis i la densitat (D2, D3, D6, D9) no
  són decisions d'arquitectura i van amb les seves peces. Fora d'abast:
  l'aplicació mòbil, una finestra sense marc, el redactor en una finestra
  pròpia (D5) i la cerca entre mòduls.

## Context

Avui (`frontend/src/App.tsx`, `main` del 2026-10-17):

- **De dalt a baix:** la barra de títol del sistema (a macOS, oculta, amb la
  franja `MacTitleBar` per als botons de la finestra), la barra d'estat de la
  sincronització (`ConnectivityBanner`, sempre visible si hi ha comptes), l'avís
  d'actualització (`UpdateBanner`) i un sol `<main>` amb tota la resta.
- **Dins de `<main>`:** la barra vertical (`SideNav`, un `<aside>` de 3,75 rem,
  oculta per sota de 769 px) amb la safata unificada, els mòduls, els taulers
  kanban i els comptes (tots dos ordenables), l'indicador de no molestar i el
  menú «Més»; després, només al correu i per sobre de 1024 px, la navegació
  «Comptes i carpetes» (`MailNavigation`, 220 px); després, el mòdul. Cada
  mòdul té la seva pròpia columna esquerra: calendari 192 px, persones 288,
  notes 320, xat 288, tasques cap. Els diàlegs i els avisos també són dins de
  `<main>`.
- **Mòdul actiu:** sis booleans a `ui$` (`calendarOpen`, `peopleOpen`…); el
  correu és quan tots són falsos. No es desa entre reinicis.
- **Cerca:** un camp a la capçalera de cada subfinestra; Ctrl/⌘+Maj+F
  (`search.global`) posa el focus al de la llista de converses o del tauler.
  Ctrl/⌘+K obre la paleta d'ordres.
- **Dreceres de la barra:** Ctrl/⌘+1…9 (`view.rail1`…`view.rail9`) obren les
  posicions de la barra en ordre: la safata unificada si es mostra, els taulers
  i els comptes visibles. No obren mòduls.
- **Amplades:** per sota de 769 px el correu té una sola subfinestra i
  `CompactNavigation` (Enrere i el menú «Més»); entre 769 i 1024 px la
  navegació de carpetes s'amaga i queda el selector «Canvia de carpeta»; per
  sobre de 1024 px es veu. El zoom és l'escala pròpia (`font_scale`, fins al
  200 %): el que es mesura en rem creix i les media queries continuen llegint
  l'amplada real.
- **Teclat:** no hi ha cap drecera per passar d'una subfinestra a una altra
  (F6) ni regions amb nom a part de `<main>`, «Comptes i carpetes» i la barra
  lateral de detalls.

La proposta aprovada demana un marc igual en tots els mòduls, com el del
client de referència, però amb la identitat d'Oreneta.

## Decisió

### 1. Estructura i regions

D'inici a final i de dalt a baix, en propietats lògiques (ADR-0061):

| Regió | Element i nom accessible | Contingut |
|---|---|---|
| Barra de títol | la del sistema | Sense canvis. A macOS es manté `MacTitleBar`. |
| Capçalera | `<header>` (`banner`), «Oreneta» | Dues files: la banda superior (§2) i la barra d'eines principal (§3). |
| Avisos | com avui | `UpdateBanner` i, només quan cal (§2), la barra d'error de la sincronització. |
| Carpetes | `<nav>`, nom del mòdul (al correu, «Comptes i carpetes», el d'avui) | La subfinestra de carpetes (§4), amb el selector de mòduls al peu (§5), que és un altre `<nav>`, «Mòduls». |
| Contingut | `<main>`, nom del mòdul | La llista i el lector o el contingut del mòdul. |
| Barra lateral | `<aside>` (`complementary`) | ADR-0069. |

- Hi ha un sol `<main>` i cada regió té un nom únic. Els diàlegs, els avisos
  (toasts) i les confirmacions surten de `<main>` i es pinten com a germans de
  les regions, de manera que `<main>` només conté el mòdul.
- **Un sol estat de mòdul:** els sis booleans es converteixen en un valor
  (`ui$.module`: `mail`, `calendar`, `people`, `tasks`, `notes`, `chat`,
  `attachments`). És estat de la interfície, no dades desades; impedeix
  combinacions impossibles (dos mòduls oberts) que avui només evita cada botó
  posant els altres a fals. L'aplicació continua arrencant al correu.

### 2. Banda superior (D7)

- **Alçada** 2,25 rem (36 px al 100 %), en rem perquè creixi amb el zoom. Fons
  del to «marc» (D2). Dins de la finestra, sota la barra nativa: cap patró nou
  de Wails.
- **A l'inici:** el botó «Menú de l'aplicació», que obre un menú (rols `menu`
  i `menuitem` i teclat de la peça 7) amb les ordres de la paleta agrupades per
  àrea, més el que avui hi ha al menú «Més» de la barra (visualització, tema,
  taulers). Les ordres surten de la mateixa llista que la paleta
  (`useCommandList`): no n'hi ha una segona. La paleta (Ctrl/⌘+K) no canvia.
- **Al centre:** el camp de cerca (`role="search"`), amb l'abast del mòdul
  actiu. Mou el mateix estat de cerca que avui mou el camp del mòdul (al correu,
  la consulta de `mail.threadList`); el camp de la capçalera de la llista de
  converses desapareix en lloc de duplicar-se. El constructor de cerques i les
  cerques desades s'obren des d'un botó al final del camp. Ctrl/⌘+Maj+F i la
  `/` de l'esquema Gmail hi posen el focus. Els mòduls que avui no tenen cerca
  (calendari) mostren el camp desactivat amb el motiu, no un camp que no fa res.
- **Al final:** l'indicador de no molestar (avui a la barra) i l'estat de la
  sincronització:
  - un botó amb icona i text curt («Sincronitzat», «Se sincronitzen 2
    comptes», «3 comptes necessiten atenció»); per sota de 1025 px, només la
    icona, amb el mateix text com a nom accessible i com a indicació. La regió
    `role="status"` d'avui es manté (visualment oculta quan només hi ha la
    icona);
  - el botó obre, com a finestra emergent no modal ancorada, el detall d'avui
    de `ConnectivityBanner`: cada compte, la seva observació i les seves
    accions;
  - **no es degrada mai a una icona sola:** quan un compte necessita tornar a
    connectar-se o hi ha una fallada no descartada (el cas `prominent`
    d'avui), es continua mostrant la barra d'amplada completa sota la
    capçalera fins que es descarta, com avui.
- **Finestra estreta (menys de 769 px):** el menú, un botó de cerca que obre
  el camp sobre la banda i l'estat de la sincronització com a icona. Res no
  surt de la finestra al 200 %.

### 3. Barra d'eines principal

- **Alçada** 2,5 rem (40 px). Una per mòdul, amb el mateix lloc: sota la banda,
  a tota l'amplada. Fa servir la primitiva `Toolbar` de la peça 8
  (`role="toolbar"`, nom, fletxes en el sentit de lectura, Inici i Fi).
- **Contingut:** a l'inici, el botó dividit «Nou» del mòdul i «Actualitza»;
  després, les accions de l'element seleccionat, que deixen les capçaleres de
  64 px de les subfinestres (que baixen a 40 px). El que no hi cap va a un
  menú «Més» (mesurat amb `ResizeObserver`), mai en una segona línia ni amb
  desplaçament horitzontal. Una acció que no es pot fer amb la selecció actual
  es mostra desactivada i s'anuncia.
- Cada mòdul declara les seves accions; el marc només les col·loca. Les
  dreceres d'una lletra (j, k, e, s…) continuen igual.

### 4. Subfinestra de carpetes comuna

- **Un sol component** (`components/shell/FolderPane.tsx`) per a tots els
  mòduls: fila de títol de 40 px, cos (el que hi posa el mòdul), una ranura de
  peu opcional (el minicalendari, peça 4) i el selector de mòduls (§5).
- **Amplada:** 260 px per defecte, de 200 a 400, amb el separador
  `PaneResizer` d'ADR-0059 (punter, teclat, dreta a esquerra, mida dibuixada).
  Una sola amplada per a tots els mòduls, desada a la preferència nova
  `folder_pane_width` i ajustada als límits en llegir-la. Les amplades són en
  px, com les altres que es poden arrossegar.
- **Què hi posa cada mòdul** (és el que avui té a la seva columna esquerra,
  no funcions noves):

  | Mòdul | Cos |
  |---|---|
  | Correu | Safata unificada, comptes, preferides, carpetes, cerques desades i, nou, els taulers kanban (§5) |
  | Calendari | La llista de calendaris de `CalendarList.tsx`; al peu, el minicalendari |
  | Persones | Llibretes i grups |
  | Tasques | Les llistes (avui pestanyes), amb el detall a la peça 11 |
  | Notes | La cerca i les etiquetes d'avui |
  | Xat | El compte, les invitacions, els grups i les converses directes |
  | Adjunts | Els filtres d'avui (nom, remitent, tipus, data, compte) |

- La semàntica d'arbre (`tree`, `treeitem`, fletxes) arriba amb cada mòdul en
  la seva peça, amb les seves proves; mentrestant cada mòdul conserva la que
  té. El nom «Comptes i carpetes» del correu es manté.

### 5. Selector de mòduls (D1)

- **Per sobre de 1024 px:** una tira al peu de la subfinestra de carpetes, de
  2,5 rem d'alçada: Correu, Calendari, Persones, Tasques, Notes, Xat i, si no hi
  caben, «Més» amb la resta (Adjunts). Icones Lucide sense text; el nom va a
  `title` (indicació) i al nom accessible, de manera que les proves que fan
  `getByTitle('People')` continuen trobant el botó. L'actiu porta
  `aria-current="page"`, el fons de selecció i una barra d'accent a la vora
  superior; Correu i Xat porten el comptador de no llegits.
- **Teclat:** cada botó és una parada de Tab, com les pestanyes d'ADR-0061, i
  a més les fletxes laterals el recorren en el sentit de lectura, amb Inici i Fi.
- **Entre 769 i 1024 px**, on avui la navegació de carpetes ja s'amaga: la
  subfinestra de carpetes continua oculta i els mòduls queden en una barra
  vertical estreta d'icones (3 rem), sense comptes ni taulers. El selector
  «Canvia de carpeta» d'avui continua donant les carpetes i els comptes.
- **Per sota de 769 px:** com avui, `CompactNavigation`; els mòduls s'obren
  des del menú de l'aplicació.
- **El que hi havia a la barra vertical:**
  - els comptes ja són a «Comptes i carpetes»; s'hi afegeix el que només feia
    la barra: ordenar-los arrossegant (dnd-kit, també amb el teclat), el menú
    contextual del compte, el comptador i deixar-hi anar un canal RSS;
  - els taulers kanban passen a una secció «Taulers» de la subfinestra del
    correu, ordenables com ara;
  - el menú «Més» passa al menú de l'aplicació; l'indicador de no molestar, a
    la banda.
- **Ctrl/⌘+1…9 no canvien de significat:** obren les mateixes posicions
  (safata unificada, taulers, comptes visibles), ara en l'ordre de la
  subfinestra del correu, que és el mateix que tenia la barra. Els mòduls no
  tenen drecera per defecte; la paleta i el menú tenen una ordre «Ves a: …» per
  a cadascun.

### 6. Teclat: F6 entre regions

- **F6** porta el focus a la regió següent i **Maj+F6** a l'anterior, en
  aquest ordre: cerca de la banda, barra d'eines, carpetes, llista o contingut,
  lector, barra lateral. Se salten les regions que no es veuen (per amplada o
  perquè el mòdul no en té). L'ordre és el mateix en dreta a esquerra: és
  l'ordre del document, no un costat.
- Dins d'una regió, el focus torna a l'últim element que hi tenia el focus o, si
  no, al primer que el pot rebre.
- Les tecles de funció no escriuen text: F6 funciona també des d'un camp de text
  (com el zoom). No fa res amb un diàleg modal obert, que reté el focus.
- Les dues dreceres són al catàleg de dreceres (`pane.next`, `pane.prev`) i es
  poden reassignar. El marc aïllat del missatge HTML les ha de reenviar, com ja
  fa amb les de Ctrl/⌘.
- Wails desactiva les dreceres del navegador al WebView; que F6 arriba a la
  pàgina a WebView2 i a WebKitGTK no està comprovat i s'ha de provar a
  l'aplicació nativa (N4). Fins aleshores, la documentació no ho promet.

### 7. Dreta a esquerra, zoom i amplades

- **Dreta a esquerra:** tot el marc és en propietats lògiques; el guardià
  `lib/physicalDirection.test.ts` ja cobreix `components/shell/`. En àrab, la
  subfinestra de carpetes i el selector queden a la dreta i la barra lateral a
  l'esquerra; les fletxes del selector, de la barra d'eines i dels separadors
  segueixen la lectura.
- **Zoom:** alçades i espais en rem; amplades arrossegables en px (com avui).
  Al 200 % d'una finestra de 1440 px (720 px CSS) el marc és el de menys de
  769 px. Cap botó no queda fora de la finestra i no hi ha desplaçament
  horitzontal.
- **Amplades mínimes** a 1025 px, la més estreta amb carpetes: 260 (carpetes)
  + 280 (llista) + 360 (lector) = 900 px, més la barra lateral minimitzada
  d'ADR-0069 (40 px). El separador de les carpetes cedeix abans que la llista,
  i la llista abans que el lector, com fa avui la llista (ADR-0059).

### 8. Proves que es mantenen i que canvien

- **Es mantenen sense canvis d'expectativa:** els límits del correu a 599, 600,
  601, 768, 769, 1024 i 1025 px, en clar i en fosc; «la navegació cedeix
  l'espai al selector de carpetes estret» (no visible a 1024 i 600 px); la
  llista recordada de 560 px que deixa espai al lector; la disposició al 200 %
  (720 px CSS a escala 2); el zoom amb el teclat; les auditories axe per tema,
  en català, en àrab i al 200 % (cap infracció crítica ni greu); el guardià de
  direcció física; `lib/themes.test.ts` i `design-primitives.test.tsx`.
- **Canvien, en la mateixa peça que canvia el que proven:** els localitzadors
  `main > aside` de la barra (proves d'àrab) passen al `<nav>` «Mòduls»; la
  prova de no molestar busca l'indicador a la banda; la de l'estat de la
  sincronització, al botó de la banda i la seva finestra emergent.
- **Noves:** F6 i Maj+F6 recorren les regions visibles en ordre, també des d'un
  camp de text i en àrab; una auditoria axe amb les regles de regions
  (`region`, `landmark-unique`, `landmark-one-main`), que no són a les etiquetes
  WCAG que es fan servir avui, no troba res al marc nou; la tira, la
  barra estreta i el menú compacte a 1025, 1024, 769 i 768 px; l'amplada de
  les carpetes es desa, es recupera i s'ajusta als límits; Ctrl/⌘+1…9 obren
  les mateixes posicions que abans.

### 9. Ordre de migració

Cada pas és una incidència i una PR, es pot publicar sol i deixa les proves en
verd:

1. **Regions i F6, sense canvi visual:** `ui$.module`, els diàlegs fora de
   `<main>`, els noms de les regions i F6 sobre les regions d'avui.
2. **Peça 10, subfinestra de carpetes:** `FolderPane` i `folder_pane_width`,
   primer al correu (la `MailNavigation` d'avui dins del marc) i després, un per
   PR, calendari, persones, tasques, notes, xat i adjunts. La barra vertical
   encara hi és.
3. **Peça 13, banda superior:** menú de l'aplicació, cerca i estat de la
   sincronització; la barra d'eines principal quan la primitiva de la peça 8
   existeixi.
4. **Peça 14, selector de mòduls:** la tira, la barra estreta de 769–1024 px,
   els comptes i els taulers a la subfinestra del correu, i treure `SideNav`.
5. Després, la barra lateral d'ADR-0069 (peça 12).

## Alternatives descartades

- **Barra vertical actual més estreta** (l'altra opció de D1): el propietari va
  triar la tira.
- **Finestra sense marc a Windows** (l'altra opció de D7): és un patró nou de
  Wails (arrossegar, botons de la finestra, ajustos d'Aero Snap) i el
  propietari va triar la banda dins de la finestra.
- **Amplada de carpetes per mòdul:** més preferències per a una diferència que
  ningú no ha demanat; el client de referència en fa servir una.
- **Ctrl/⌘+1…6 per als mòduls,** com el client de referència: canviaria el
  que fan avui aquestes dreceres per a qui ja les fa servir.
- **Mantenir els camps de cerca de cada subfinestra a més del de la banda:**
  dos camps per a la mateixa consulta, que poden dir coses diferents.
- **Tabulació itinerant al selector** (una sola parada de Tab): és el patró
  WAI-ARIA, però ADR-0061 va mantenir totes les pestanyes a l'abast del Tab per
  no canviar l'ordre que les persones ja fan servir.
- **Una biblioteca de disposició o de subfinestres:** el separador i el marc
  són poc codi i ja hi ha `PaneResizer`; no cal cap dependència nova.

## Conseqüències

- Cap dependència nova ni canvi de dades desades fora de la preferència
  `folder_pane_width`. El canvi més gran és de codi: `App.tsx`, `SideNav.tsx`
  i les columnes esquerres de cada mòdul.
- Les capçaleres de 64 px de les subfinestres passen a 40 px i perden les
  accions, que van a la barra d'eines: les proves que les busquen allà canvien
  en el pas corresponent.
- Les cadenes noves (menú, estat curt de la sincronització, «Mòduls»,
  «Taulers», «Ves a: …») van primer en català i després a tots els catàlegs
  (`scripts/i18n/`).
- Al registre d'acceptació, cada pas porta la seva nota datada; cap fila no
  canvia d'estat sense l'evidència nativa (N4) que demana.

## Decisions que ha de prendre el propietari

1. **Ctrl/⌘+1…9:** mantenir les posicions d'avui (recomanat) o fer-les servir
   per als mòduls.
2. **Entre 769 i 1024 px:** barra estreta d'icones de mòduls (recomanat) o cap
   selector visible (mòduls només des del menú de l'aplicació).
3. **Amplada de la subfinestra de carpetes:** una per a tots els mòduls
   (recomanat) o una per mòdul.
4. **Cerca:** el camp de la banda substitueix el de la llista de converses
   (recomanat) o conviuen.
5. **Taulers kanban:** secció «Taulers» a la subfinestra del correu (recomanat)
   o un mòdul propi a la tira.
6. **F6 i Maj+F6** com a dreceres noves per defecte (recomanat).
