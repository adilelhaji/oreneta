# ADR-0068: Marc comú de l'aplicació: banda superior, barra d'eines, subfinestra de carpetes i selector de mòduls

- Estat: acceptada pel propietari el 2026-10-18 («Sí a todo»), amb l'opció
  recomanada en cada decisió:
  1. Ctrl/⌘+1…9 mantenen la seqüència d'avui (safata unificada, taulers,
     comptes);
  2. entre 769 i 1024 px, barra estreta d'icones de mòduls;
  3. una sola amplada de la subfinestra de carpetes per a tots els mòduls, en px;
  4. el camp de la banda substitueix els camps de cerca de les subfinestres;
  5. els taulers kanban, a la secció «Taulers» de la subfinestra del correu;
  6. Xat i Adjunts, dins de la subfinestra comuna;
  7. F6 i Maj+F6 com a dreceres per defecte, que actuen també dins d'un camp de
     text;
  8. l'estat de la sincronització a la banda, només amb els textos d'avui, sense
     «Sincronitzat».

  Abans, el 2026-10-17, el propietari havia aprovat la proposta de redisseny
  («Lo apruebo») amb les decisions D1 (selector de mòduls com a tira al peu de la
  subfinestra de carpetes, en lloc de la barra vertical) i D7 (banda superior
  dins de la finestra, sota la barra de títol nativa, i no una finestra sense
  vora). Les decisions D1–D9, la frase i la data consten a
  [#288](https://github.com/adilelhaji/oreneta/issues/288#issuecomment-6240630278),
  perquè la proposta no és al repositori.
- Data: 2026-10-17 (proposta); 2026-10-18 (acceptació).
- Abast: #288, peces 10 (subfinestra de carpetes comuna), 13 (banda
  superior) i 14 (selector de mòduls) de la proposta de redisseny. Sobre
  ADR-0059 (separadors), ADR-0061 (dreta a esquerra) i ADR-0062 (català), i
  sobre els límits de [mail-boundaries.md](../design/mail-boundaries.md), el
  zoom de [keyboard-zoom.md](../design/keyboard-zoom.md) i l'estat de la
  sincronització d'[account-sync-health.md](../design/account-sync-health.md).
  La barra lateral dreta és a ADR-0069; els colors, els radis i la densitat (D2,
  D3, D6, D9) no són decisions d'arquitectura i van amb les seves peces. Fora
  d'abast: l'aplicació mòbil, una finestra sense vora, el redactor en una
  finestra pròpia (D5) i la cerca entre mòduls.

## Context

Avui (`frontend/src/App.tsx`, `main` del 2026-10-17):

- **De dalt a baix:** la barra de títol del sistema (a macOS, oculta, amb la
  franja `MacTitleBar` per als botons de la finestra), la regió «Sincronització
  dels comptes» (`ConnectivityBanner`, sempre visible si hi ha comptes), l'avís
  d'actualització (`UpdateBanner`) i un sol `<main>` amb tota la resta.
- **Dins de `<main>`:** la barra vertical (`SideNav`, un `<aside>` de 3,75 rem,
  oculta per sota de 769 px) amb la safata unificada (i el seu menú contextual:
  grups de comptes i «amaga»), els mòduls, els taulers kanban i els comptes
  (tots dos ordenables), l'indicador de no molestar i el menú «Més»; després,
  només al correu sense cap tauler obert i per sobre de 1024 px, la navegació
  «Comptes i carpetes» (`MailNavigation`, 220 px: preferides, safata unificada,
  grups i comptes); després, el mòdul. Calendari, Persones, Notes i Xat tenen
  una columna esquerra pròpia (192, 288, 320 i 288 px, en rem); Tasques té
  pestanyes i Adjunts una franja de filtres. Els diàlegs i els avisos també són
  dins de `<main>`.
- **Mòdul actiu:** sis booleans a `ui$` (`calendarOpen`, `peopleOpen`…); el
  correu és actiu quan tots són falsos. No es desa entre reinicis.
- **Cerca:** un camp a la capçalera de cada subfinestra; Ctrl/⌘+Maj+F
  (`search.global`) posa el focus al de la llista de converses o del tauler.
  Ctrl/⌘+K obre la paleta d'ordres.
- **Dreceres de la barra vertical:** Ctrl/⌘+1…9 (`view.rail1`…`view.rail9`)
  obren, en aquest ordre, la safata unificada (si es mostra), els taulers i els
  comptes visibles (`AppHotkeys.tsx`). No obren mòduls. Les preferències
  `show_unified_inbox_in_sidenav` i `hidden_sidenav_accounts` decideixen què
  hi surt.
- **Amplades:** per sota de 769 px el correu té una sola subfinestra i
  `CompactNavigation` (Enrere i el menú «Més»); entre 769 i 1024 px la
  navegació de carpetes s'amaga i queda el selector «Canvia de carpeta»; per
  sobre de 1024 px es veu.
- **Dos zooms:** el de l'aplicació (`font_scale`, fins al 200 %) fa créixer el
  que es mesura en rem, i les media queries continuen llegint l'amplada real;
  el del sistema o de WebView2 redueix l'amplada CSS (1440 px al 200 % són
  720 px CSS a escala 2).
- **Teclat:** ja hi ha regions amb nom (`<main>`, «Comptes i carpetes», la
  regió de la sincronització, les categories de la safata, la barra lateral de
  detalls), però cap drecera per passar d'una a una altra (F6).

## Decisió

### 1. Estructura i regions

D'inici a final i de dalt a baix, en propietats lògiques (ADR-0061):

| Regió | Element i nom accessible | Contingut |
|---|---|---|
| Barra de títol | la del sistema | Sense canvis. A macOS es manté `MacTitleBar`. |
| Capçalera | `<header>` (`banner`), «Oreneta» | Dues files: la banda superior (§2) i la barra d'eines principal (§3). |
| Avisos | com avui | `UpdateBanner` i, només quan cal (§2), la barra d'atenció de la sincronització. |
| Carpetes | `<nav>`, pel seu contingut: «Comptes i carpetes» (correu, el d'avui), «Calendaris», «Llibretes», «Llistes de tasques», «Etiquetes», «Converses», «Filtres» | La subfinestra de carpetes (§4). |
| Mòduls | `<nav>`, «Mòduls» | El selector de mòduls (§5): al peu de les carpetes o, entre 769 i 1024 px, la barra estreta. |
| Contingut | `<main>`, el nom del mòdul («Correu», «Calendari»…) | La llista i el lector o el contingut del mòdul. |
| Barra lateral | `<aside>` (`complementary`) | ADR-0069. |

- Hi ha un sol `<main>`, i cap regió no comparteix nom amb una altra. Els
  diàlegs, els avisos (toasts) i les confirmacions surten de `<main>` i es
  pinten com a germans de les regions, de manera que `<main>` només conté el
  mòdul.
- **Un sol estat de mòdul:** els sis booleans es converteixen en un valor
  (`ui$.module`: `mail`, `calendar`, `people`, `tasks`, `notes`, `chat`,
  `attachments`). És estat de la interfície, no dades desades; impedeix
  combinacions impossibles (dos mòduls oberts) que avui només evita cada botó
  posant els altres a fals. L'aplicació continua arrencant al correu.

### 2. Banda superior (D7)

- **Alçada** 2,25 rem (36 px al 100 %), en rem perquè creixi amb el zoom de
  l'aplicació. Fons del to «marc» (D2). Dins de la finestra, sota la barra
  nativa: cap patró nou de Wails.
- **A l'inici:** el botó «Menú de l'aplicació», que obre un menú (rols `menu`
  i `menuitem` i teclat de la peça 7) amb les ordres de la paleta agrupades per
  àrea, més el que avui hi ha al menú «Més» de la barra vertical
  (visualització, tema, taulers). Les ordres surten de la mateixa llista que la
  paleta (`useCommandList`): no n'hi ha una segona. La paleta (Ctrl/⌘+K) no
  canvia.
- **Al centre:** el camp de cerca (`role="search"`), amb l'abast del mòdul
  actiu. Actualitza el mateix estat de cerca que avui actualitza el camp del
  mòdul (al correu, la consulta de `mail.threadList`), i els camps de cerca de
  les subfinestres desapareixen en lloc de duplicar-se. El constructor de
  cerques i les cerques desades s'obren des d'un botó al final del camp.
  Ctrl/⌘+Maj+F i la `/` de l'esquema Gmail hi posen el focus. Els mòduls que
  avui no tenen cerca (Calendari) mostren el camp desactivat amb el motiu, no
  un camp que no fa res.
- **Al final:** l'indicador de no molestar (avui a la barra vertical) i l'estat
  de la sincronització:
  - un botó amb icona i el resum que la regió d'avui ja mostra, sense afirmar
    res que no se sàpiga ([account-sync-health.md](../design/account-sync-health.md):
    no hi ha cap senyal de sincronització completa). Els únics textos són els
    d'avui: «{count} requereixen atenció», una sol·licitud en curs o sense
    confirmar, i «Estat de la sincronització completa desconegut». Mai
    «Sincronitzat». Per sota de 1025 px, només la icona, amb el mateix text com
    a nom accessible i com a indicació. La regió `role="status"` d'avui es
    manté (visualment oculta quan només hi ha la icona);
  - el botó obre, com a finestra emergent no modal ancorada, el detall d'avui
    de `ConnectivityBanner`: cada compte, la seva observació i les seves
    accions;
  - **no es degrada mai a una icona sola:** quan un compte necessita tornar a
    iniciar la sessió o hi ha una fallada no descartada (el cas `prominent`
    d'avui), es continua mostrant la barra d'amplada completa sota la
    capçalera fins que es resolgui o es descarti, com avui (una sessió que
    s'ha de tornar a iniciar no es pot descartar).
- **Finestra estreta (menys de 769 px):** el menú, un botó de cerca que obre
  el camp sobre la banda i l'estat de la sincronització com a icona.

### 3. Barra d'eines principal

- **Alçada** 2,5 rem (40 px al 100 %). Una per mòdul, sempre al mateix lloc:
  sota la banda, a tota l'amplada. Fa servir la primitiva `Toolbar` de la peça
  8 (`role="toolbar"`, nom, fletxes en el sentit de lectura, Inici i Fi).
- **Contingut:** a l'inici, el botó dividit «Nou» del mòdul i «Actualitza»;
  després, les accions de l'element seleccionat, que deixen les capçaleres de
  64 px de les subfinestres (que baixen a 40 px). El que no hi cap va al menú
  «Més accions» (mesurat amb `ResizeObserver`), mai en una segona línia ni
  amb desplaçament horitzontal. Una acció que no es pot fer amb la selecció
  actual es mostra desactivada i s'anuncia.
- **Sempre visibles:** «Més accions» i, al correu, «Arxiva la conversa» no van
  mai al menú de desbordament i conserven el nom accessible d'avui: les proves
  de límits del correu els esperen dins de la pantalla.
- Cada mòdul declara les seves accions; el marc només les col·loca. Les
  dreceres d'una lletra (j, k, e, s…) continuen igual.

### 4. Subfinestra de carpetes comuna

- **Un sol component** (`components/shell/FolderPane.tsx`): fila de títol de
  40 px, cos (el que hi posa el mòdul), una ranura de peu opcional (el
  minicalendari, peça 4) i el selector de mòduls (§5).
- **Amplada:** 260 px per defecte, de 200 a 400, amb el separador
  `PaneResizer` d'ADR-0059 (punter, teclat, dreta a esquerra, mida dibuixada).
  Una sola amplada per a tots els mòduls, desada a la preferència nova
  `folder_pane_width` i ajustada als límits en llegir-la. En px, com les altres
  amplades que s'ajusten amb un separador: amb el zoom de l'aplicació el text hi
  creix i la subfinestra no (§7); un nom que no hi cap es talla amb «…» i el
  nom sencer va a la indicació.
- **Què hi posa cada mòdul:**

  | Mòdul | Cos | Respecte d'avui |
  |---|---|---|
  | Correu | Preferides, safata unificada, taulers kanban (secció «Taulers»), grups, comptes, carpetes i cerques desades | Hi entren els taulers |
  | Calendari | La llista de `CalendarList.tsx`; al peu, el minicalendari | Mateix contingut |
  | Persones | Llibretes i grups | Mateix contingut |
  | Tasques | Les llistes (avui pestanyes) | Canvi de lloc |
  | Notes | Les etiquetes (la cerca passa a la banda) | Mateix contingut |
  | Xat | El compte, les invitacions, els grups i les converses directes | Mateix contingut; ampliació de la proposta |
  | Adjunts | Els filtres d'avui (nom, remitent, tipus, data, compte) | Canvi de lloc; ampliació de la proposta |

  La proposta aprovada parlava de Correu, Calendari, Tasques, Persones i
  Notes; Xat i Adjunts hi entren per tenir un sol marc, i ho ha de decidir el
  propietari (decisió 6).
- **Taulers kanban:** amb un tauler obert, la subfinestra de carpetes del
  correu es continua mostrant (el tauler hi és seleccionat). La subfinestra de
  conversa del tauler passa a ser un percentatge de l'àrea de contingut (la
  fila menys les carpetes), amb els límits d'avui (25–60 % i 320 px com a
  mínim).
- Al correu, el cos conserva l'ocultació de carpetes de #273 (`folder_hidden` i
  «Mostra les carpetes amagades») tal com és a `MailNavigation`.
- La semàntica d'arbre (`tree`, `treeitem`, fletxes) arriba amb cada mòdul en
  la seva peça, amb les seves proves; mentrestant cada mòdul conserva la que
  té.

### 5. Selector de mòduls (D1)

- **Per sobre de 1024 px:** una tira al peu de la subfinestra de carpetes, de
  2,5 rem d'alçada: Correu, Calendari, Persones, Tasques, Notes, Xat i Adjunts.
  Els que no hi caben (mesurat amb `ResizeObserver`; al 200 % de l'aplicació,
  en 260 px n'hi caben dos més el botó «Més») van a «Més», en l'ordre de la tira; l'actiu no
  hi va mai. Icones Lucide sense text; el nom va a `title` (indicació) i al nom
  accessible, de manera que les proves que fan `getByTitle('People')` continuen
  trobant el botó. L'actiu porta `aria-current="page"`, el fons de selecció i
  una barra d'accent a la vora superior; Correu i Xat porten el comptador de no
  llegits.
- **Teclat:** cada botó és una parada de Tab, com les pestanyes d'ADR-0061, i
  a més les fletxes laterals el recorren en cercle en el sentit de lectura, amb
  Inici i Fi.
- **Entre 769 i 1024 px**, on avui la navegació de carpetes ja s'amaga: la
  subfinestra de carpetes continua oculta i els mòduls queden en una barra
  vertical estreta d'icones (3 rem), sense comptes ni taulers. El selector
  «Canvia de carpeta» d'avui continua donant accés a les carpetes i als
  comptes.
- **Per sota de 769 px:** com avui, `CompactNavigation`; els mòduls s'obren
  des del menú de l'aplicació.
- **El que hi havia a la barra vertical:**
  - els comptes ja són a «Comptes i carpetes»; s'hi afegeix el que només feia
    la barra vertical: poder-los ordenar arrossegant-los (dnd-kit, també amb el
    teclat), el menú contextual del compte, el comptador i la possibilitat de
    deixar-hi anar un canal RSS;
  - els taulers kanban passen a la secció «Taulers», entre la safata unificada
    i els grups de comptes, ordenables com ara;
  - el menú contextual de la safata unificada (mostrar un grup de comptes,
    amagar-la) passa a la fila de la safata unificada;
  - el menú «Més» passa al menú de l'aplicació; l'indicador de no molestar, a
    la banda.
- **Preferències:** `show_unified_inbox_in_sidenav` i
  `hidden_sidenav_accounts` conserven la clau i el que fan avui (què surt a
  «Comptes i carpetes» i a les dreceres). Només canvia el text de Configuració,
  que ja no parla de la barra vertical. No cal cap migració.
- **Ctrl/⌘+1…9 no canvien:** conserven la seva seqüència (safata unificada si
  es mostra, taulers, comptes visibles), independent de l'ordre de la
  pantalla. Els mòduls no tenen drecera per defecte; la paleta i el menú tenen
  una ordre «Ves a: …» per a cadascun.

### 6. Teclat: F6 entre regions

- **F6** porta el focus a la regió següent i **Maj+F6** a l'anterior, en
  aquest ordre: cerca de la banda, barra d'eines, carpetes, mòduls, llista o
  contingut, lector, barra lateral. Se salten les regions que no es veuen (per
  amplada o perquè el mòdul no en té). L'ordre és el mateix en dreta a
  esquerra: és l'ordre del document, no un costat.
- Dins d'una regió, el focus torna a l'últim element que hi tenia el focus o, si
  no, al primer que el pot rebre.
- **Les tecles de funció funcionen mentre s'escriu:** avui una drecera sense
  Ctrl/⌘ ni Alt és «nua» i no actua dins d'un camp de text (`isBareShortcut`);
  F1–F12 en queden fora, perquè no escriuen text. Si algú reassigna la drecera
  a una lletra, torna a valer la barrera. El marc aïllat (iframe) del missatge
  HTML, que avui només reenvia les tecles amb Ctrl/⌘ o Alt i les fletxes, també
  reenviarà F1–F12. Amb un diàleg modal obert, F6 no fa res: el diàleg reté el
  focus.
- Les dues dreceres són al catàleg (`pane.next`, `pane.prev`) i es poden
  reassignar.
- Wails desactiva les dreceres del navegador al WebView; encara no s'ha
  comprovat que F6 arribi a la pàgina a WebView2 i a WebKitGTK, i s'ha de provar
  a l'aplicació nativa (N4). Si no hi arriba, la drecera per defecte passa a una
  combinació amb Ctrl/⌘ que sí que hi arribi, en un canvi propi; fins aleshores
  la documentació d'usuari no promet F6.

### 7. Dreta a esquerra, zoom i amplades

- **Dreta a esquerra:** tot el marc és en propietats lògiques; el guardià
  `lib/physicalDirection.test.ts` recorre tot `src/components`, també
  `components/shell/`. En àrab, la subfinestra de carpetes i el selector queden
  a la dreta i la barra lateral a l'esquerra; les fletxes del selector, de la
  barra d'eines i dels separadors segueixen la lectura.
- **Zoom de l'aplicació (`font_scale`) al 200 %:** les media queries no
  canvien, de manera que es veu el mateix marc que al 100 % per a aquella
  amplada (ample a 1440 px, amb la barra estreta a 1024 px), amb tot el que es
  mesura en rem al doble de mida. A dalt, banda i barra d'eines fan 4,75 rem
  (152 px); al peu de
  les carpetes, la tira fa 2,5 rem (80 px), i el selector de panells de la barra
  lateral, també. La tira hi cap perquè desborda a «Més» (§5); la barra
  d'eines, perquè desborda a «Més accions» (§3). Les columnes que avui són en
  rem (Calendari, Persones, Notes, Xat) passen a l'amplada en px de la
  subfinestra i deixen de créixer amb el zoom: és el criteri que
  keyboard-zoom.md ja aplica a les amplades que s'ajusten amb un separador.
- **Zoom del sistema o de WebView2:** 1440 px al 200 % són 720 px CSS, i el
  marc és el de les finestres de menys de 769 px.
- **Amplades a 1025 px** (la més estreta amb carpetes), al 100 %: amb els
  mínims, 200 (carpetes) + 280 (llista) + 360 (lector) = 840 px, més la tira
  minimitzada de la barra lateral (2,5 rem, 40 px) = 880 px; amb les carpetes
  per defecte, 940 px. Hi caben totes dues. Quan no hi caben, les carpetes
  cedeixen fins al seu mínim abans que la llista, i la llista abans que el
  lector, com fa avui la llista (ADR-0059). Avui la barra vertical (60 px) i la
  navegació (220 px) sumen 280 px; el marc nou en fa servir entre 200 i 400.

### 8. Proves que es mantenen i que canvien

- **Es mantenen amb les mateixes expectatives:** els límits del correu a 599,
  600, 601, 768, 769, 1024 i 1025 px, en clar i en fosc (amb «Arxiva la
  conversa» i «Més accions» dins de la pantalla, §3); «la navegació cedeix
  l'espai al selector de carpetes estret» (no visible a 1024 i 600 px); la
  llista recordada de 560 px que deixa espai al lector; la disposició a 720 px
  CSS a escala 2; el zoom amb el teclat al 200 % a 1440 i 1024 px; les
  auditories axe per tema, en català, en àrab i al 200 % (cap infracció crítica
  ni greu); el guardià de direcció física; `lib/themes.test.ts` i
  `design-primitives.test.tsx`.
- **Canvien, en la mateixa peça que canvia el que proven:** els localitzadors
  `main > aside` de la barra vertical (proves d'àrab) passen al `<nav>`
  «Mòduls»; la prova de no molestar busca l'indicador a la banda; la de l'estat
  de la sincronització, al botó de la banda i la seva finestra emergent; les
  que trobaven el camp de cerca a la capçalera de la llista, al de la banda.
- **Noves:** F6 i Maj+F6 recorren les regions visibles en ordre, també des d'un
  camp de text, des del missatge HTML i en àrab; una reassignació a una lletra
  torna a respectar la barrera; una auditoria axe amb les regles de regions
  (`region`, `landmark-unique`, `landmark-one-main`), que no són a les etiquetes
  WCAG que es fan servir avui, no troba res al marc nou; la tira, la barra
  estreta i el menú compacte a 1025, 1024, 769 i 768 px; el desbordament de la
  tira i de la barra d'eines al 200 % de l'aplicació a 1440 i 1025 px, i la
  barra estreta al 200 % a 1024 px, sense desplaçament horitzontal; l'amplada de les carpetes es desa, es recupera i
  s'ajusta als límits; Ctrl/⌘+1…9 obren les mateixes posicions que abans.

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
   els comptes, els taulers i el menú de la safata unificada a la subfinestra
   del correu, i la retirada de `SideNav`.
5. Després, la barra lateral d'ADR-0069 (peça 12).

## Alternatives descartades

- **Barra vertical actual més estreta** (l'altra opció de D1): el propietari va
  triar la tira.
- **Finestra sense vora a Windows** (l'altra opció de D7): és un patró nou de
  Wails (arrossegar, botons de la finestra, ajustos d'Aero Snap) i el
  propietari va triar la banda dins de la finestra.
- **Amplada de carpetes per mòdul:** més preferències per a una diferència que
  ningú no ha demanat; el client de referència en fa servir una.
- **Ctrl/⌘+1…7 per als set mòduls** (el client de referència fa servir
  Ctrl+número per als seus): canviaria el que fan avui aquestes dreceres per a
  qui ja les fa servir.
- **Mantenir els camps de cerca de cada subfinestra a més del de la banda:**
  dos camps per a la mateixa consulta, que poden dir coses diferents.
- **Un resum «Sincronitzat» a la banda:** l'aplicació no té cap senyal que ho
  demostri (account-sync-health.md); seria un positiu inventat.
- **Tabulació itinerant al selector** (una sola parada de Tab): és el patró
  WAI-ARIA, però ADR-0061 va mantenir totes les pestanyes a l'abast del Tab per
  no canviar l'ordre que les persones ja fan servir.
- **Una biblioteca de disposició o de subfinestres:** el separador i el marc
  són poc codi i ja hi ha `PaneResizer`; no cal cap dependència nova.

## Conseqüències

- Cap dependència nova ni canvi de dades desades fora de la preferència
  `folder_pane_width`. El canvi més gran és de codi: `App.tsx`, `SideNav.tsx`,
  `AppHotkeys.tsx`, `lib/shortcuts.ts`, `HtmlFrame.tsx` i les columnes
  esquerres de cada mòdul.
- Les capçaleres de 64 px de les subfinestres passen a 40 px i perden les
  accions, que van a la barra d'eines: les proves que les busquen allà canvien
  en el pas corresponent.
- Les cadenes noves (menú, «Mòduls», «Taulers», els noms de les regions, «Ves
  a: …») van primer en català i després a tots els catàlegs (`scripts/i18n/`).
- **Documents que cada pas actualitza:** mail-boundaries.md (la barra de
  comptes), keyboard-zoom.md (la barra `w-15`), mail-navigation.md,
  right-to-left.md i account-sync-health.md.
- **Registre d'acceptació:** cada pas porta la seva nota datada i torna a
  registrar l'evidència automàtica de les files que toca, lligada al resum
  (hash) nou: S01-04 (#84) i S01-05 (#85, límits de les subfinestres), SET-27
  (#37, dreta a esquerra) i SET-23 (#86). Cap fila no canvia d'estat sense
  l'evidència nativa (N4) que demana.

## Decisions del propietari

Preses el 2026-10-18: en totes, l'opció recomanada (vegeu l'estat).

1. **Ctrl/⌘+1…9:** mantenir la seqüència d'avui (recomanat) o fer-les servir
   per als mòduls.
2. **Entre 769 i 1024 px:** barra estreta d'icones de mòduls (recomanat) o cap
   selector visible (mòduls només des del menú de l'aplicació).
3. **Amplada de la subfinestra de carpetes:** una per a tots els mòduls, en px
   com les altres amplades que s'ajusten amb un separador (recomanat), o una per mòdul.
4. **Cerca:** el camp de la banda substitueix els de les subfinestres
   (recomanat) o conviuen.
5. **Taulers kanban:** secció «Taulers» a la subfinestra del correu (recomanat)
   o un mòdul propi a la tira.
6. **Xat i Adjunts** dins de la subfinestra comuna (recomanat: un sol marc) o
   amb la disposició pròpia d'avui.
7. **F6 i Maj+F6** com a dreceres noves per defecte, que actuen també dins d'un
   camp de text (recomanat).
8. **Estat de la sincronització a la banda** amb només els textos d'avui
   (atenció, sol·licitud, desconegut), sense «Sincronitzat» (recomanat).
