# Regions de l'aplicació i F6 (#306)

Pas 1 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §6 i §9): regions
amb nom i F6 entre elles, sense cap canvi visual. Els passos següents (la
subfinestra de carpetes, la banda superior i el selector de mòduls) canvien el
que hi ha a cada regió, no aquest mecanisme.

Codi: `frontend/src/lib/regions.ts`, `states/ui.ts` (`ui$.module`), `App.tsx`,
`components/dialog/AppHotkeys.tsx`, `lib/shortcuts.ts`,
`components/chat/HtmlFrame.tsx`, `components/shell/ModuleSwitcher.tsx` (el
selector de mòduls, des de #354, en lloc de `components/sidenav/SideNav.tsx`),
`components/banner/UpdateBanner.tsx`, `components/shell/AppHeader.tsx` (la banda
superior, des de #343), `components/shell/BandSearch.tsx` (la cerca de la banda,
des de #344), `components/shell/SyncStatus.tsx` i
`components/banner/ConnectivityBanner.tsx` (l'estat de la sincronització a la
banda i la barra sota la capçalera, des de #345), `components/shell/AppSidebar.tsx`
(la barra lateral de l'aplicació, des de #361) i els `data-region` de les vistes
de cada mòdul.

## Un sol estat de mòdul

- `ui$.module` (`mail`, `calendar`, `people`, `tasks`, `notes`, `chat`,
  `attachments`) substitueix els sis booleans d'abans (`calendarOpen`,
  `peopleOpen`…). Dos mòduls no poden estar oberts alhora, i ja no cal que cada
  botó posi els altres a fals.
- És estat de la interfície, no dades desades: l'aplicació arrenca al correu.
- `toggleModule` és el que feia cada botó de la barra vertical, i el que fa cada
  botó del selector de mòduls des de #354: obre el mòdul o, si ja està obert, torna
  al correu.

## Regions

| Regió | Element | Nom accessible | `data-region` |
|---|---|---|---|
| Capçalera (des de #343) | `<header>` (`banner`), fora de `<main>`, entre la barra de títol i els avisos | «Oreneta», en tots els idiomes | — |
| Banda superior (des de #343): la primera fila de la capçalera, amb el botó «Menú de l'aplicació» ([top-band.md](top-band.md)) | dins del `<header>` | — | `search` |
| Cerca de la banda (des de #344): el camp, amb l'abast del mòdul en pantalla, al centre de la banda o, per sota de 769 px, damunt de la banda quan s'obre | `role="search"`, dins de la banda | «Cerca» | — (és dins de `search`) |
| Barra de la sincronització (des de #345, només en el cas destacat: una sessió per tornar a iniciar, o una fallada o un problema sense compte no descartats) | `<section>` (`region`), sota la capçalera, fora de `<main>` | «Sincronització dels comptes» | — |
| Selector de mòduls (des de #354): la tira de mòduls al peu de la subfinestra de carpetes, a partir de 1025 px, o la barra estreta, de 769 a 1024 px; abans, la barra vertical | `<nav>` (la barra vertical era un `<aside>`) | «Mòduls» | `modules` |
| Subfinestra de carpetes del correu (`FolderPane`, des de #317; des de #353, també amb un tauler obert) | `<nav>` | el de la seva fila de títol: «Comptes i carpetes» | `folders` |
| Subfinestra de carpetes del Calendari (`FolderPane`, des de #323); per sota de 1025 px, la columna d'abans | `<nav>` | «Calendaris» | `folders` |
| Subfinestra de carpetes de Persones (`FolderPane`, des de #326): els grups; per sota de 1025 px, el filtre de grups d'abans, sota la capçalera de la llista | `<nav>` | «Grups de contactes» | `folders` |
| Subfinestra de carpetes de Tasques (`FolderPane`, des de #329): les llistes; per sota de 1025 px, les pestanyes d'abans, sota la capçalera | `<nav>` | «Llistes de tasques» | `folders` |
| Subfinestra de carpetes de Notes (`FolderPane`, des de #335): les etiquetes; per sota de 1025 px, els botons d'etiqueta d'abans, sobre la llista de notes | `<nav>` | «Etiquetes de notes» | `folders` |
| Subfinestra de carpetes de Xat (`FolderPane`, des de #337): les converses; per sota de 1025 px, la columna d'abans | `<nav>` | «Converses» | `folders` |
| Subfinestra de carpetes d'Adjunts (`FolderPane`, des de #339): els filtres; per sota de 1025 px, la barra de filtres d'abans, sota la capçalera | `<nav>` | «Filtres d'adjunts» | `folders` |
| Mòdul | `<main>` | el del mòdul: «Correu», «Calendari», «Persones», «Tasques», «Notes», «Xat», «Adjunts» | — |
| Llista de converses o tauler; als altres mòduls, el mòdul sencer | la d'avui | — | `content` |
| Lector | `[data-message-pane]` | — | `reader` |
| Barra lateral de l'aplicació (des de #361; abans, la barra lateral de detalls d'una conversa, dins del lector): desplegada, minimitzada en una tira o com a capa ([contextual-sidebar.md](contextual-sidebar.md#la-barra-lateral-de-laplicació-361)) | `<aside>` (`complementary`), després de `<main>`, al final de la fila del marc, a tots els mòduls | «Barra lateral» | `sidebar` |

- Hi ha un sol `<main>`. Els diàlegs de l'aplicació, els avisos (toasts), les
  confirmacions i l'avís de certificat en surten i es pinten al costat de les
  regions.
- La barra lateral de l'aplicació (#361, ADR-0069 §1) és fora de `<main>`, després
  d'ell, a la fila del marc (`data-frame-row`), i n'hi ha una sola: substitueix la
  barra lateral de detalls, que era dins del lector i només hi era amb una
  conversa oberta. Desplegada, minimitzada en la seva tira o com a capa, és la
  mateixa regió `sidebar`, amb el mateix nom; amagada, o per sota de 769 px sense
  la capa oberta, no hi és. El seu nom, «Barra lateral», no coincideix amb el de
  cap altra regió, i el seu selector de panells, «Panells de la barra lateral»,
  no és cap punt de referència. El botó «Barra lateral» de la banda és dins de la
  regió `search`, com la resta del final de la banda.
- La capçalera (#343) és el `<header>` «Oreneta», el punt de referència `banner`
  de la finestra. Es pinta després de `MacTitleBar` i abans de la barra de la
  sincronització (quan hi és) i d'`UpdateBanner`, fora de `<main>`, com demana
  ADR-0068 §1 (barra de títol, capçalera, avisos i la resta). El seu nom és el
  de l'aplicació, igual en els 20 catàlegs, i no coincideix amb el de cap altra
  regió en cap idioma, com comprova una prova; el del botó «Menú de l'aplicació»
  tampoc no coincideix amb el «Més» que tenia la barra vertical.
- La cerca de la banda (#344) és el punt de referència `search`, «Cerca»
  (`shell.region.search`), dins de la capçalera. És l'únic de la finestra, i el
  seu nom no coincideix amb el de la capçalera ni amb el de cap altra regió en
  cap dels 20 catàlegs, com comprova una prova. A la pantalla d'alta no hi és.
- El final de la banda (#345) no afegeix cap punt de referència: l'indicador del
  mode No molestis i el botó de l'estat de la sincronització són dins de la
  capçalera i de la regió `search` d'F6, i la finestra emergent del detall és un
  `dialog` no modal, que no és cap punt de referència, dins de la banda. La
  regió «Sincronització dels comptes» d'abans, que sempre hi era quan hi havia
  comptes, ara només hi és en el cas destacat, com a barra d'amplada completa
  sota la capçalera, amb el nom d'abans, diferent del de la capçalera, del de la
  cerca i del nom del botó del menú en els 20 catàlegs, com comproven les proves
  de #343 i #344. Hi ha una sola regió `role="status"` per a l'estat de la
  sincronització, la de la banda, i una per al mode No molestis, també la de la
  banda: la barra vertical en mostrava el botó, no l'estat, i des de #354 no hi
  és. Per sota de 769 px,
  quan el camp de cerca cobreix la banda, només en són inerts els controls; les
  dues regions d'estat continuen a l'arbre d'accessibilitat (vegeu
  [top-band.md](top-band.md#el-final-de-la-banda-345)).
- La pantalla d'alta del primer compte (#343) té la mateixa capçalera, amb la
  banda (`search`), i després l'alta del compte dins de `<main>`, que és la
  regió `content`: F6 i Maj+F6 van d'una a l'altra. Només hi actuen les dreceres
  de l'aplicació (vegeu
  [top-band.md](top-band.md#la-pantalla-dalta-del-primer-compte)).
- Els diàlegs que obre un mòdul (l'editor d'una persona, l'editor i el detall
  d'un esdeveniment, la revisió del context de l'assistent, la galeria
  d'imatges) es pinten dins d'aquest mòdul i són modals (`aria-modal="true"`).
  L'editor i el detall d'un esdeveniment, la revisió de l'assistent i la galeria
  no ho eren. Ara són `ModalCard` (`components/dialog/ModalCard.tsx`), sense cap
  canvi visual: `role="dialog"`, `aria-modal` i nom; en obrir-se prenen el focus
  (si no el té ja un control de dins) i en tancar-se el tornen a l'element que
  els havia obert, com el `Dialog` compartit.
- Amb un diàleg modal obert tampoc no actuen les dreceres de les posicions de
  Ctrl/⌘+1…9 (abans les de la barra vertical, i des de #354 les de «Comptes i
  carpetes»), ni la tecla que s'hi hagi assignat.
- La barra vertical i la subfinestra de carpetes van continuar dins de `<main>`
  fins que el selector de mòduls va substituir la barra (pas 4, #354): la barra
  es pintava abans que les carpetes, a la mateixa fila. Al pas 2 (#317) la
  subfinestra de carpetes comuna va substituir «Comptes i carpetes» al correu,
  amb el mateix nom i la mateixa regió, i a partir de 1025 px també la columna
  de calendaris del Calendari (#323), els grups de Persones (#326), les llistes
  de Tasques (#329), les etiquetes de Notes (#335), les converses de Xat
  (#337) i els filtres d'Adjunts (#339). Les proves que hi arribaven amb
  `main > aside` van canviar al pas 4 (ADR-0068 §8), quan la barra va passar a
  ser el `<nav>` «Mòduls» d'ADR-0068 §1. Des de #354 és així: la tira de mòduls és al
  peu de la subfinestra, que continua dins de `<main>` perquè la pinta cada
  mòdul, i la barra estreta, a l'inici de `<main>`, on era la barra vertical. Que
  `<main>` només contingui el mòdul, com vol ADR-0068 §1, és un pas pendent: des
  de #361 la barra lateral ja n'és fora, però la subfinestra de carpetes i la
  barra estreta, no.
- La barra vertical tenia nom perquè no hi hagués dues regions complementàries
  sense nom quan la barra lateral de detalls estigués oberta. Des de #354 el selector
  de mòduls és un `<nav>` «Mòduls», i només n'hi ha un a la vegada: la tira es
  munta mentre la subfinestra es pinta, i la barra estreta, de 769 a 1024 px.
- Fins al pas 2, la columna de Notes té el mateix nom que `<main>` («Notes»).
  Són de rols diferents i axe no ho marca, però ADR-0068 §1 no ho permet: el pas
  2 li dona el nom «Etiquetes». La del Calendari, que es deia «Calendari» com
  `<main>`, es diu «Calendaris» des de #323. La de Persones no era cap punt de
  referència (una `<section>` sense nom, només la regió `folders`): la
  subfinestra de #326 es diu «Grups de contactes», diferent de `<main>`
  («Persones») i de «Grups» en tots els catàlegs, per decisió del propietari.
  Tasques no tenia cap regió «carpetes» (les pestanyes eren dins del mòdul): la
  subfinestra de #329 es diu «Llistes de tasques», diferent de `<main>`
  («Tasques») en els 20 catàlegs, per decisió del propietari. A Notes, la
  columna de la llista, que es deia «Notes» com `<main>`, ja no és la regió
  «carpetes» a partir de 1025 px: ho és la subfinestra de #335, que es diu
  «Etiquetes de notes» (`notes.tagsPane`), diferent de `<main>` («Notes») i de
  la resta de noms de regió en els 20 catàlegs, com comprova una prova. Per sota
  de 1025 px la columna conserva la regió i el nom d'abans. A Xat passa el mateix:
  la columna de converses, que ja es deia «Converses» (`messaging.conversations`),
  és la subfinestra de #337 a partir de 1025 px i conserva el nom, que és
  diferent de `<main>` («Xat») i de la resta de noms de regió i de llista de Xat
  («Grups», «Converses directes», «Invitacions») en els 20 catàlegs, com comprova
  una prova; per sota de 1025 px és la columna d'abans. A Adjunts, que no tenia
  cap regió «carpetes», la subfinestra de #339 es diu «Filtres d'adjunts»
  (`attachmentsView.filters`), diferent de `<main>` («Adjunts») i de les
  etiquetes dels seus propis controls en els 20 catàlegs, com comprova una prova;
  per sota de 1025 px no hi ha cap regió «carpetes» i la barra de filtres és
  dins del contingut, com abans.
- L'avís d'actualització és una regió que té per nom el mateix text de l'avís,
  perquè no quedi contingut fora de cap regió. Encara no té cap prova
  automàtica: les proves arrenquen sense cap actualització disponible.

## F6 i Maj+F6

- **Ordre:** cerca de la banda, barra d'eines, carpetes, mòduls, llista o
  contingut, lector i barra lateral (`REGION_ORDER`). Des de #343, la regió
  `search` és la banda superior sencera, i F6 hi porta el focus al botó «Menú de
  l'aplicació» o a l'últim element que hi tenia el focus, com ara el camp de
  cerca, que hi és des de #344, o el botó de l'estat de la sincronització, al
  final de la banda des de #345. F6 des de la finestra emergent de l'estat la
  tanca i passa a la regió següent. Encara no hi ha barra d'eines. Al correu,
  doncs, l'ordre era aquest fins a #354: banda, carpetes, barra vertical, llista,
  lector i barra lateral; a la resta de mòduls, banda, carpetes, barra vertical i
  el mòdul. La barra vertical es pintava abans que les carpetes, però F6 hi
  arribava després: és l'ordre del marc nou, on els mòduls són al peu de les
  carpetes (pas 4), i així no va canviar d'un pas a l'altre. ADR-0068 §6 diu que
  és l'ordre del document: al marc nou tots dos coincideixen, i mentre la barra
  vertical es pintava abans que les carpetes, manava la llista de l'ADR. Des de #354 coincideixen:
  la tira de mòduls és al peu de les carpetes, una regió dins d'una altra, i F6
  hi va després de les carpetes; entre 769 i 1024 px, sense carpetes, la barra
  estreta va abans que el mòdul.
- **La barra lateral (#361):** és l'última regió, també quan està minimitzada:
  la tira té una icona per panell, i per defecte (`minimized`) és a la pantalla
  a partir de 769 px. Per això, després del lector (o del mòdul, fora del
  correu) F6 hi va abans de tornar a la banda, encara que no hi hagi cap
  conversa oberta. Com a capa és la mateixa regió; amagada no hi és.
- **Sota la capa de la barra lateral (#361):** mentre està oberta, `<main>` és
  `inert`, amb la barra estreta de mòduls, les carpetes i el mòdul: és el que
  cobreix el fons. F6 i Maj+F6 només van entre la banda i la barra, i Tab tampoc
  no entra al mòdul. En tancar-se, `<main>` deixa de ser inert i el focus torna a
  l'element que l'havia oberta (vegeu
  [contextual-sidebar.md](contextual-sidebar.md#obrir-tancar-i-el-focus)). La
  banda no queda sota el fons i continua activa.
- **Cicle:** després de l'última regió, F6 torna a la primera. Des de fora de
  qualsevol regió, F6 va a la primera i Maj+F6, a l'última.
- **Se salten** les regions que no es veuen (perquè l'amplada les amaga o perquè
  són `inert`, `aria-hidden` o `hidden`) i les que no tenen res que pugui rebre
  el focus.
- **Dins d'una regió,** el focus torna a l'últim element que el tenia, si encara
  el pot rebre; si no, va al primer element al qual s'arriba amb Tab. Una regió
  dins d'una altra (la columna esquerra dins del mòdul) és una regió a part: els
  seus elements no compten per a la de fora.
- **Dreta a esquerra:** el mateix ordre, que no depèn del costat de la finestra.
- **Mentre s'escriu:** les dreceres «nues» (d'una sola tecla, sense Ctrl/⌘ ni
  Alt) no actuen dins d'un camp de text; és la barrera d'`isBareShortcut`.
  F1–F12 no escriuen text i en queden fora, de manera que F6 també funciona des
  d'un camp de text. Si algú reassigna F6 a una lletra, torna a valer la barrera
  i dins d'un camp s'escriu la lletra.
- **Qualsevol drecera en una tecla de funció:** val el mateix per a totes, no
  només per a F6 (per exemple, F9 per sincronitzar, de l'esquema Outlook, ara
  també actua dins d'un camp de text), però amb un diàleg modal obert no actuen,
  com abans.
- **Des del missatge HTML:** el marc aïllat reenvia F1–F12, a més de les
  dreceres amb Ctrl/⌘ o Alt i de les fletxes.
- **Diàleg modal obert** (`aria-modal="true"`): F6 no fa res i el diàleg reté el
  focus.
- **Catàleg:** `pane.next` i `pane.prev`, al diàleg *Dreceres de teclat*, grup
  «View», es poden reassignar. Els noms dels grups i de les dreceres encara no
  són al catàleg de traduccions, com abans d'aquest pas.
- **Pendent (N4):** encara no s'ha comprovat que F6 arribi a la pàgina a
  WebView2 i a WebKitGTK. Fins aleshores la documentació d'usuari no promet F6
  (ADR-0068 §6).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`lib/regions.test.ts`) | L'ordre del marc i, dins d'un mateix tipus, el del document; un tipus desconegut falla; les regions amagades, inertes o sense res que pugui rebre el focus se salten; un element que no accepta el focus no compta; el cicle d'anada i tornada; el focus torna a l'últim element; una regió dins d'una altra; un diàleg modal; la banda superior és la primera regió i F6 surt del seu menú cap a la regió següent (#343) |
| N2 (`components/shell/AppHeader.test.tsx`) | La capçalera «Oreneta» amb la banda (`search`) com a primera fila; el nom de la capçalera i el del botó del menú, diferents dels de les altres regions en els 20 catàlegs, també del de la cerca (#343, #344) |
| N2 (`components/shell/BandSearch.test.tsx`) | El punt de referència «Cerca» al centre de la banda, dins de la regió `search`; el seu nom, diferent del de les altres regions en els 20 catàlegs (#344) |
| N2 (`components/dialog/AppHotkeys.test.tsx`) | F6 des d'un camp de text, amb la tecla consumida; res amb un diàleg modal d'un mòdul ni amb Configuració oberta; la paleta d'ordres es queda les tecles; reassignada a una lletra, s'escriu dins d'un camp; reassignada a F8, actua mentre s'escriu i no amb un diàleg modal; una posició de Ctrl/⌘+1…9 (abans, de la barra vertical) assignada a una tecla de funció no actua amb un diàleg modal d'un mòdul |
| N2 (`components/dialog/ModalCard.test.tsx`) | Diàleg modal amb nom; pren el focus de l'element que l'obre i l'hi torna en tancar-se; respecta el focus que un control de dins ja ha pres |
| N1 (`lib/shortcuts.test.ts`) | F6 i Maj+F6 per defecte, sense col·lisions; F1–F12 no són nues; reassignar F6 a una lletra torna a posar la barrera |
| N2 (`HtmlFrame.test.tsx`) | El marc reenvia F1–F12, amb Maj o sense, i no una lletra |
| N1 (`states/uiModule.test.ts`) | Els set mòduls; el botó del selector de mòduls (abans, de la barra vertical) obre el mòdul i, si ja està obert, torna al correu; mai dos mòduls alhora |
| N1 (`lib/regions.test.ts`, #354) | La tira de mòduls dins de les carpetes: després de les carpetes en l'ordre, una regió a part, que se'n va amb la subfinestra; la barra estreta sola, abans del mòdul |
| N2 (`components/shell/ModuleSwitcher.test.tsx`, #354) | El `<nav>` «Mòduls», la regió `modules`, amb un botó per mòdul que és una parada de Tab; les fletxes en el sentit de lectura, Inici i Fi, i les tecles que deixa passar; el focus quan la tira es torna a pintar i quan un botó passa a «Més» |
| e2e (`startup.e2e.ts`, «#354») | La tira, la barra estreta i el menú compacte a 1025, 1024, 769 i 768 px, amb un sol `<nav>` «Mòduls» i F6; el teclat de la tira en català i en àrab; les regles de regions d'axe a 1440, 1024 i 768 px i al 200 % amb «Més» obert |
| N2 (proves dels mòduls) | `ui$.module` en lloc dels sis booleans |
| N2 (`components/shell/AppSidebar.test.tsx`, #361) | Una sola regió complementària «Barra lateral», `sidebar`, després de `<main>` i fora d'ell, a cada mòdul; el selector de panells amb el teclat, en anglès i en àrab |
| e2e (`startup.e2e.ts`, «#361») | F6 i Maj+F6 a través de la barra desplegada, al correu i al Calendari, i axe dins de la barra a cada amplada, en català i en àrab; a 1024 px, amb la capa oberta, `<main>` inert, F6 i Maj+F6 només entre la banda i la barra, Tab que no entra al mòdul i el focus que torna a la fila en tancar-la (vegeu [contextual-sidebar.md](contextual-sidebar.md#la-barra-lateral-de-laplicació-361)) |
| N2 (`components/shell/SyncStatus.test.tsx`, #345) | El final de la banda dins de la regió `search`, després de la cerca en l'ordre de Tab; cap punt de referència nou: la finestra emergent és un `dialog` dins de la capçalera, i la barra, l'única regió «Sincronització dels comptes»; una sola regió d'estat per a la sincronització i una per al mode No molestis |
| e2e (`startup.e2e.ts`, «#345») | Tab des del botó del menú fins al botó de l'estat, sense sortir de la regió `search`; F6 des de la finestra emergent la tanca i va a les carpetes, i Maj+F6 torna al botó; les regles de regions d'axe amb la barra i la finestra oberta, i en àrab |
| e2e (`startup.e2e.ts`, «#306») | A 1440 px, en anglès, català i àrab: un sol `<main>` amb el nom del mòdul, la barra vertical «Mòduls» (des de #354, el `<nav>` «Mòduls», l'únic amb aquest nom) i F6 / Maj+F6 en el mateix ordre, des de #343 passant per la banda, fins a tornar a la fila de la llista. Des d'un camp de text (des de #344, el de la cerca de la banda, d'on F6 va a les carpetes), des del missatge HTML (des de #361, d'on F6 va a la tira de la barra lateral i després a la banda) i amb un diàleg modal obert; un avís emergent (toast) i el diàleg fora de `<main>`. Al calendari, a Persones, a Tasques, a Notes, a Xat i a Adjunts, F6 va del mòdul a la barra lateral (des de #361, desplegada amb `i` al correu), a la banda (des de #343), a la seva columna (des de #323, #326, #329, #335, #337 i #339, a la subfinestra de carpetes) i torna a la barra vertical (des de #354, a la tira de mòduls). Una reassignació a una lletra. A 600 px, només les regions que es veuen (la banda, que s'hi veu, i la llista o el lector); al 200 % de l'aplicació, el mateix ordre sense desplaçament horitzontal (des de #361, amb la tira de la barra lateral després del lector). Les regles de regions d'axe (`region`, `landmark-unique`, `landmark-one-main`) no troben res a la bústia ni a cap mòdul |

Les proves de límits, de zoom, de dreta a esquerra i les auditories axe que ja
hi havia no canvien: aquest pas no mou res de lloc. La banda superior (#343) hi
afegeix les seves pròpies proves «#343» (vegeu [top-band.md](top-band.md)).
