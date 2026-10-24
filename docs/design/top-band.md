# Banda superior i menú de l'aplicació (#343)

Peça 13a del redisseny, pas 3 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §2 i §9). Les
decisions del propietari per a tota la peça 13 consten a
[#342](https://github.com/adilelhaji/oreneta/issues/342): la barra vertical va
conservar el menú «Més» i l'indicador del mode No molestis fins a la peça 14 (se'n
van anar amb la barra a #354; vegeu [Sense la barra vertical](#sense-la-barra-vertical-354)), i
la peça es lliura en tres PR (13a, la banda i el menú; 13b, la cerca, #344; 13c,
l'estat de la sincronització i l'indicador del mode No molestis a la banda,
#345). Les decisions que van sorgir durant la implementació de 13a consten a
[#343](https://github.com/adilelhaji/oreneta/issues/343): el menú és pla, amb
grups amb títol (decisió 1); la pantalla d'alta del primer compte també té la
banda (decisió 2); i els problemes del correu al 200 % a 1025 px van a una
incidència pròpia (decisió 3). La cerca de la banda (13b) és a
[#344](https://github.com/adilelhaji/oreneta/issues/344), on consten també les
dues decisions del propietari sobre la cerca; vegeu [La cerca](#la-cerca-344).
L'estat de la sincronització i l'indicador del mode No molestis al final de la
banda (13c) són a [#345](https://github.com/adilelhaji/oreneta/issues/345);
vegeu [El final de la banda](#el-final-de-la-banda-345).

Codi: `frontend/src/components/shell/AppHeader.tsx`,
`components/shell/AppMenu.tsx`, `components/shell/BandSearch.tsx` (la cerca,
#344), `components/shell/AppFrame.tsx`,
`components/shell/AppLayers.tsx`, `components/setup/SetupScreen.tsx`,
`components/palette/paletteCommands.ts` (`area`, `menuOnly`, `COMMAND_AREAS`,
`groupCommandsByArea`), `components/palette/useCommandList.ts`,
`components/palette/CommandPalette.tsx`, `components/dialog/AppHotkeys.tsx`,
`components/dialog/SettingsDialog.tsx` (`onAddAccount`), `lib/useDialogFocus.ts`
i `App.tsx`. El final de la banda (#345) és a `components/shell/SyncStatus.tsx`
(l'estat de la sincronització i la seva finestra emergent),
`components/banner/ConnectivityBanner.tsx` (el resum, el detall i la barra sota
la capçalera) i `components/sidenav/QuietIndicator.tsx` (el mode No molestis).
La cerca de la conversa demanada des d'un altre mòdul (#344) és a
`components/chat/MessagePane.tsx` i a `states/thread.ts`.

## La capçalera i la banda

- **On és:** dins de la finestra, sota la barra de títol del sistema (a macOS,
  sota `MacTitleBar`, sense cap patró nou de Wails) i damunt dels avisos (la
  barra de la sincronització, quan cal, i `UpdateBanner`), fora de `<main>`. És
  l'ordre d'ADR-0068 §1: barra de títol, capçalera, avisos i la resta.
- **Capçalera:** un `<header>` (`banner`) amb el nom «Oreneta», que és el nom de
  l'aplicació i no es tradueix (`shell.region.banner`, igual en els 20 catàlegs).
  La banda n'és la primera fila; la barra d'eines principal (§3) en serà la
  segona quan existeixi la primitiva de la peça 8.
- **Banda:** 2,25 rem d'alçada (`h-9`), és a dir, 36 px al 100 % i 72 px al
  200 % de l'aplicació, amb el to del marc d'avui (`--me-bg-header`) fins que
  #287 hi posi el to «marc», i un divisor a sota. Té tres zones en fila:
  l'inici, amb el botó «Menú de l'aplicació»; el centre, que ocupa l'espai que
  queda i té el camp de cerca (13b, [La cerca](#la-cerca-344)); i el final, amb
  l'indicador del mode No molestis i l'estat de la sincronització (13c,
  [El final de la banda](#el-final-de-la-banda-345)).
- **Totes les amplades:** la banda i el botó es veuen a qualsevol amplada, també
  per sota de 769 px, on el camp de cerca deixa lloc a un botó de cerca (13b) i
  l'estat de la sincronització és una icona (13c).
- **Regió d'F6:** la banda és la regió `search`, la primera de `REGION_ORDER`
  (vegeu [app-regions.md](app-regions.md)); F6 hi porta el focus al botó del
  menú. El camp de cerca (13b) i el final (13c) hi són sense canviar la regió.
- **La pantalla d'alta del primer compte** també té la banda, amb el mateix botó
  «Menú de l'aplicació» (decisió 2 del propietari a #343): la barra de títol, la
  capçalera «Oreneta» i, després, l'alta del compte dins de `<main>`, que és la
  regió `content`. F6 i Maj+F6 van de la banda a l'alta i tornen. Vegeu
  [la pantalla d'alta](#la-pantalla-dalta-del-primer-compte).

## El menú de l'aplicació

- **Botó:** «Menú de l'aplicació» (`appMenu.label`), amb `aria-haspopup="menu"` i
  `aria-expanded`. El nom és diferent del «Més» del selector de mòduls (abans, del
  de la barra vertical) en tots els catàlegs.
- **Contingut:** totes les ordres de la paleta (`useCommandList`), cadascuna una
  sola vegada, agrupades per àrea (`MenuGroup`, amb el títol de l'àrea com a nom
  del grup). No hi ha cap segona llista: el que el menú «Més» de la barra vertical
  tenia i la paleta no, ara és a `useCommandList`, i per això la paleta també ho
  té. L'única excepció és «Paleta d'ordres», que només surt al menú
  (`menuOnly`): a la paleta només obriria la mateixa paleta.
- **Un menú pla** (decisió 1 del propietari a #343): una sola llista amb un grup
  amb títol per a cada àrea, sense submenús. Amb comptes, carpetes i temes té
  entre 70 i 100 elements i es desplaça; més endavant hi pot haver un submenú
  per àrea.
- **Àrees**, en aquest ordre (`COMMAND_AREAS`):

  | Àrea | Títol | Ordres |
  |---|---|---|
  | `modules` | Mòduls | «Ves a: Correu» i un «Ves a: …» per a cada mòdul |
  | `mail` | Correu | Redactar, l'enviament personalitzat, els pendents de resposta, sincronitzar, marcar-ho tot com a llegit, les dues cerques i els tres filtres |
  | `conversation` | Conversa | Respondre, l'editor complet, arxivar, destacar, marcar com a no llegit, suprimir i tancar la pestanya; aquestes ordres només hi són quan escau |
  | `accounts` | Comptes | Afegir un compte, la safata unificada i cada compte |
  | `folders` | Carpetes | Cada carpeta del compte |
  | `boards` | Taulers | Crear un tauler kanban i cada tauler |
  | `theme` | Tema | Cada tema |
  | `notifications` | Notificacions | Les tres pauses del mode No molestis o «Reprèn les notificacions» |
  | `settings` | Configuració | «Obre la configuració» i, després, cada secció que pot obrir |
  | `app` | Aplicació | La paleta d'ordres, les dreceres de teclat, el catàleg de disseny i «Quant a Oreneta» |

  Dins d'una àrea, les accions van abans que les seccions de la configuració, i
  cada tipus conserva l'ordre de la llista. La paleta no fa servir les àrees.
- **El menú «Més» de la barra vertical** es trobava també al menú de l'aplicació
  (des de #354 només hi ha el menú de l'aplicació):
  els mòduls, la paleta, afegir un compte, afegir un tauler, sincronitzar, el
  mode No molestis, la configuració i «Quant a». Afegir un compte, afegir un
  tauler, sincronitzar i la configuració ja eren ordres de la paleta i hi surten
  una sola vegada, amb el que fa la paleta: afegir un tauler el crea de seguida
  amb el nom per defecte, com «Crea un tauler kanban», sense el diàleg del nom
  de la barra vertical, i el mostra al correu, encara que l'ordre s'hagi
  executat des d'un altre mòdul.
- **Ordres noves de la paleta:** un «Ves a: …» per a cada mòdul (ADR-0068 §5),
  «Quant a Oreneta» i les del mode No molestis, amb els sinònims als catàlegs
  (`commands.aliases.module`, `.app.about` i `.notifications`). «Paleta
  d'ordres» és nova al menú, no a la paleta, i no té sinònims als catàlegs:
  cap cerca no la busca.
- **Destinacions del correu des d'un altre mòdul:** «Ves a: Correu», un compte,
  un tauler, una carpeta o un tauler nou tornen al correu, com feia la barra
  vertical. Abans, des del Calendari, la paleta canviava la selecció del correu
  sense mostrar-la. Només es marquen quan el correu és a la pantalla: «Ves a:
  Correu», un compte o una carpeta, sense cap tauler obert; un tauler, quan és
  obert. Des d'un altre mòdul, cap d'aquestes no es marca.
- **Estat:** les ordres que mostren un estat (el mòdul, el tema, el filtre, el
  compte, la carpeta, el tauler) són `menuitemradio` amb `aria-checked`, i la
  marcada té el text en el color d'accent i una marca al final. Les altres són
  `menuitem`. Una ordre que no es pot fer (en un compte de només lectura) és
  `aria-disabled`, no fa res i diu per què amb el text de la paleta: a la
  indicació (`title`), per al punter, i com a descripció accessible
  (`aria-describedby`, un text visualment ocult amb `sr-only` al costat de
  l'element), per al teclat i els lectors de pantalla, on no arriba la
  indicació. Les dreceres es mostren al final de la fila i no formen part del
  nom.
- **Executar una ordre:** primer el focus torna al botó i després s'executa
  l'ordre, com fa la paleta. Així, un diàleg que s'obri (la configuració, «Quant
  a», la paleta) torna el focus al botó en tancar-se, i una ordre que mou el focus
  (la cerca, la resposta) el pren des del botó.

## Teclat i focus

- Retorn, Espai o Avall l'obren amb el focus al primer element, i Amunt, amb el
  focus a l'últim. Dins del menú, Amunt, Avall, Inici, Fi i la cerca per lletra
  són els de la [primitiva de menús](menus.md).
- Les tecles a què respon el botó (Retorn, Espai, Avall i Amunt) s'hi queden, i
  les fletxes del menú obert també: cap no arriba a les dreceres de l'aplicació
  (`AppHotkeys`), que amb les fletxes passarien a la conversa següent de la
  llista o a la targeta següent del tauler.
- Una drecera amb Ctrl/⌘, Alt o una tecla de funció premuda dins del menú actua
  des del botó: el menú es tanca i el focus hi torna abans que la drecera actuï.
  Així, la paleta que obre Ctrl/⌘+K (o la configuració, amb Ctrl/⌘+,) torna el
  focus al botó en tancar-se, i no a un element que ja no hi és.
- Escapada el tanca i torna el focus al botó; Tab el tanca i avança des del botó.
  També el tanquen un clic o un desplaçament fora, un canvi de mida de la
  finestra, el focus en un altre lloc (F6, per exemple) i un segon clic al botó.
- És un menú llarg que es desplaça. Per això el menú mateix és una parada de Tab
  (`MenuList` amb `tabStop`), perquè la zona que es desplaça es pugui fer servir
  amb el teclat (la regla `scrollable-region-focusable` d'axe); els elements
  continuen fora de l'ordre de Tab. Quan el focus arriba a una fila, el menú es
  desplaça fins que la fila es veu sencera dins de les vores.

## Posició, dreta a esquerra i zoom

- S'obre sota el botó, amb la vora inicial a la vora inicial del botó: cap a la
  dreta, o cap a l'esquerra en àrab (`startEdgeX` i `menuLeft`).
- Fa 20 rem d'amplada, mai més ample que la finestra menys 8 px a cada costat,
  i com a màxim l'alçada que queda fins a 8 px de la vora inferior; la resta es
  desplaça.
  Les mides són en píxels sencers, perquè l'última fila no quedi tallada per mig
  píxel.
- Al 200 % de l'aplicació la banda fa 72 px. A 1025 px, aquesta alçada surt de les
  subfinestres: la pàgina no es desplaça i els controls dels límits del correu
  continuen dins de l'alçada de la finestra.
- **Límit conegut, anterior a la banda:** al 200 % i a 1025 px, «Més accions» de
  la capçalera de la conversa ja quedava en part fora de la vora final. La banda
  no mou res cap als costats; la barra d'eines principal (§3) és la peça que
  canvia aquesta capçalera.

## La pantalla d'alta del primer compte

Decisió 2 del propietari a #343: sense cap compte, la finestra també té la
banda.

- **Estructura:** la pantalla d'alta i la finestra comparteixen el marc
  (`components/shell/AppFrame.tsx`): la barra de títol (`MacTitleBar`), la
  capçalera «Oreneta» amb la banda i el botó «Menú de l'aplicació», i les capes
  (diàlegs, avisos emergents i confirmacions). A la pantalla d'alta, el marc té
  a dins l'alta del compte, a `<main>`, que és la regió `content`
  (`components/setup/SetupScreen.tsx`). Com abans, no hi ha els avisos de la
  finestra (`ConnectivityBanner`, `UpdateBanner`).
- **El marc no es torna a muntar** quan arriba el primer compte: només en canvia
  el contingut. Un diàleg obert damunt de l'alta continua obert, com la
  configuració després de restaurar una còpia de seguretat que porta un compte,
  i en tancar-se torna el focus al control que l'havia obert, si encara hi és
  (el botó del menú, sí; un camp de l'alta, que ha desaparegut amb ella, no, i
  llavors el focus queda a la pàgina). El focus també hi torna quan havia caigut
  al cos de la pàgina perquè «Restaura» es desactiva mentre treballa
  (`useDialogFocus`), com als menús.
- **El menú** és el mateix, amb les ordres que no necessiten cap compte: les
  àrees `theme`, `settings` i `app` (la configuració i les seves seccions, els
  temes, la paleta, les dreceres de teclat, el catàleg de disseny i «Quant a»).
  Les que actuen sobre el correu, un mòdul o les notificacions (comptes,
  carpetes, taulers, sincronitzar, el mode No molestis) no hi surten, en lloc de
  sortir desactivades: sense compte no tenen sentit. Afegir un compte tampoc no
  hi és: la pantalla ja serveix per a això. La paleta mostra les mateixes
  ordres.
- **Els diàlegs** (`components/shell/AppLayers.tsx`) són els de la finestra: la
  configuració, la paleta, les dreceres, «Quant a», les novetats, les
  confirmacions i els avisos emergents. Aquests avisos ara també surten a la
  pantalla d'alta: abans no s'hi veien l'avís d'una arrencada fallida ni el
  d'un error greu del motor (`core.fatal`).
- **El «+» de la configuració** (al costat de «Comptes de correu» i de «Comptes
  de canals») no obre un segon diàleg d'alta damunt d'una pantalla que ja és
  l'alta: tanca la configuració i torna el focus a l'alta, on era (al principi, al
  camp de l'adreça), sense canviar-ne el proveïdor ni el que s'hi havia escrit.
- **Teclat:** només hi actuen les dreceres de l'aplicació (`AppHotkeys` amb
  `setup`): la paleta, la configuració, les dreceres de teclat, el zoom
  (Ctrl/⌘ amb =, - i 0), F6 i Maj+F6. Les fletxes, Escapada i Supr són de la
  pàgina, i les dreceres del correu no hi fan res. F6 va de la banda a l'alta i
  Maj+F6 torna.
- El focus continua començant al camp de l'adreça, com abans.

## La cerca (#344)

Peça 13b. ADR-0068 §2 i la seva decisió 4: el camp de la banda substitueix els
camps de cerca dels mòduls, que desapareixen en lloc de duplicar-se. Decisió 3
del propietari a [#342](https://github.com/adilelhaji/oreneta/issues/342): el
Calendari i el Xat, que no tenen cerca, mostren el camp desactivat amb el motiu.
Decisions del propietari a [#344](https://github.com/adilelhaji/oreneta/issues/344):

1. **El correu conserva els dos botons** al final del camp: el del constructor de
   cerques i el de les cerques desades, amb el comportament d'abans, i no un de
   sol.
2. **Les ordres de cerca van al correu:** «Cerca a tots els missatges»
   (`search.global`) i «Cerca a la conversa actual» (`search.thread`), a la
   paleta i al menú de l'aplicació, porten primer al correu, com les ordres d'un
   compte o d'una carpeta, i hi cerquen. Si hi ha una conversa oberta al
   correu, «Cerca a la conversa actual» n'obre la cerca quan la subfinestra de
   la conversa apareix (`requestThreadSearch`, a `states/thread.ts`): en
   aparèixer, la subfinestra torna a l'estat inicial i, sense aquesta petició,
   tancaria una cerca oberta abans. La petició porta l'identificador de la
   conversa i es demana abans de passar al correu. La subfinestra la respon quan
   mostra una conversa: si és la mateixa, obre la cerca, i ho recorda, de manera
   que la torna a obrir si l'efecte de muntatge es repeteix (StrictMode, en
   desenvolupament); si és una altra, la descarta. La cerca no es torna a obrir
   en mostrar una altra conversa, ni quan una carpeta deixa la subfinestra sense
   conversa, ni en retornar al correu més tard; i una petició que el correu no
   ha atès es descarta en sortir del correu. Les dreceres no
   canvien: Ctrl/⌘+Maj+F cerca al mòdul en pantalla, i Ctrl/⌘+F, al correu,
   obre la cerca de la conversa si n'hi ha una a la pantalla.

- **On és:** al centre de la banda, entre el botó del menú i el final. És el punt
  de referència `search` («Cerca», `shell.region.search`), dins de la regió
  `search` d'F6. El nom no coincideix amb el de cap altra regió en cap dels 20
  catàlegs, com comprova una prova. El camp fa com a màxim 36 rem
  (`max-w-xl`) i queda centrat; quan no hi cap, s'encongeix, i el botó del menú
  i el final de la banda conserven el seu espai.
- **Un camp, l'estat de cada mòdul:** el camp llegeix i escriu l'estat de cerca
  que el mòdul ja tenia. El nom accessible i el text de mostra del camp
  (`placeholder`) diuen què es cerca:

  | Mòdul | Nom del camp | Estat | Retard |
  |---|---|---|---|
  | Correu | «Cerca missatges…» (`threads.searchMessages`); en un compte de canals, «Cerca canals…» (`threads.searchFeeds`) | `ui$.query` → `mail.threadList` | cap, com abans |
  | Correu, amb un tauler obert | «Cerca al tauler…» (`kanban.searchBoard`) | `kanban$.searchQuery` | cap, a la memòria |
  | Notes | «Cerca a les notes» (`notes.search`) | `notes$.search` | 200 ms |
  | Persones | «Cerca persones» (`people.search`) | `people$.query` | 150 ms, al nucli |
  | Tasques | «Cerca tasques» (`tasks.search`) | `tasks$.search` | cap, a la memòria |
  | Adjunts | «Cerca adjunts pel nom del fitxer» (`attachmentsView.search`, nova) | `attachmentList$.filter.name` | 200 ms |

  Els retards són els dels efectes de cada mòdul, que no canvien, com tampoc no
  canvien els textos de la llista buida i de «cap resultat». En canviar de
  mòdul, el camp mostra la consulta d'aquell mòdul: cada mòdul conserva la seva,
  com abans, i no se'n fa una de sola.
- **Correu:** la indicació del camp (`title`) explica els operadors, com abans.
  Al final del camp hi ha els dos botons d'abans (decisió 1), amb el mateix
  comportament: «Opcions de cerca» (el constructor, que no hi és en un compte de
  canals; vegeu [search-builder.md](search-builder.md)) i «Desa aquesta cerca»
  o «Cerques desades». Amb Escapada es buida la cerca i el focus surt del camp,
  com feia el de la llista. «Esborra la cerca» la buida i torna el focus al
  camp; abans el focus es perdia amb el botó.
- **Un tauler obert al correu:** el camp cerca al tauler, i al final té el
  selector «Abast de la cerca» (totes les columnes o una). Triar una columna
  plegada la desplega, com abans. «Cerca», al menú d'accions d'una columna,
  tria la columna i posa el focus al camp de la banda. Amb Escapada es buida la
  cerca i, si ja és buida, el focus surt del camp. La capçalera del tauler ja no
  té el camp ni el botó «Cerca al tauler».
- **Calendari i Xat:** el camp hi és desactivat (`disabled`), amb el motiu com a
  text de mostra, com a indicació i com a descripció accessible
  (`aria-describedby`): «El Calendari encara no té cerca» i «El Xat encara no té
  cerca». No hi ha cap botó que no faci res, i Ctrl/⌘+Maj+F no hi posa el focus.
- **El que es queda on era,** perquè no cerca el contingut del mòdul: el filtre de
  carpetes de «Comptes i carpetes» (decisió 2 del propietari a #342), la cerca a
  la conversa (`ConversationHeader`) i els altres filtres d'Adjunts (remitent,
  tipus, quan i compte), a la subfinestra o a la barra.
- **Dreceres:** Ctrl/⌘+Maj+F (`search.global`) i la `/` de l'esquema Gmail posen
  el focus al camp i en seleccionen el text, en qualsevol mòdul. Ctrl/⌘+F
  (`search.thread`) obre la cerca de la conversa quan n'hi ha una a la pantalla
  i, si no, posa el focus al camp, com abans. Una conversa del correu només és a
  la pantalla al correu: abans, des d'un altre mòdul, Ctrl/⌘+F obria la cerca
  d'una conversa que no es veia. `focusGlobalSearch` i `ui$.globalSearchFocus`
  porten a la banda. Les ordres «Cerca a tots els missatges» i «Cerca a la
  conversa actual» de la paleta i del menú porten primer al correu (decisió 2) i
  després hi fan el mateix que les seves dreceres.
  Quan el camp apareix (en arribar el primer compte), no pren el focus, encara
  que abans s'hagi demanat.
- **Per sota de 769 px:** el centre de la banda té un botó de cerca, al final,
  amb el nom del camp del mòdul (per exemple, «Cerca missatges…»). Si hi ha una
  consulta, el botó es pinta actiu. El botó obre el camp damunt de tota la banda,
  amb el focus a dins i el botó «Tanca la cerca» (`search.band.close`) al
  final; mentrestant, la resta de la banda és `inert` (no rep ni el focus ni el
  punter). Escapada o «Tanca la cerca» tanquen el camp i tornen el focus al
  botó; la consulta es manté, perquè és la del mòdul. El camp no es tanca quan
  perd el focus: es pot fer clic a la llista i continuar veient-lo.
  Ctrl/⌘+Maj+F també l'obre. Si la finestra s'estreny mentre el camp té el
  focus, el camp continua obert damunt de la banda i amb el focus; si
  s'eixampla, torna al centre. Al Calendari i al Xat, el botó és
  `aria-disabled`, no fa res i diu el motiu a la indicació i com a descripció,
  com una ordre desactivada del menú. Si es passa a un d'aquests mòduls amb el
  camp obert, el camp es tanca i la banda torna a rebre el focus i el punter; el
  focus que era al camp va al botó. Una petició de focus que no es pot atendre
  en el pintat següent (no hi ha cap camp, o el botó ja no hi és) es descarta:
  no pren el focus més tard.
- **La pantalla d'alta del primer compte** no té el camp: no hi ha res a cercar.
  És el criteri que ja segueix el menú en aquesta pantalla, que no mostra,
  en lloc de desactivar-ho, el que necessita un compte. Quan arriba el primer
  compte, el camp apareix al centre de la banda.
- **Teclat i F6:** el camp és dins de la regió `search`. La primera vegada, F6
  hi porta el focus al botó del menú; després, a l'últim element que el tenia (el
  camp, si s'hi ha escrit). Tab va del botó del menú al camp i als seus botons.
- **Dreta a esquerra i zoom:** tot en propietats lògiques; en àrab, el camp queda
  a l'esquerra del botó del menú, i a 768 px el botó de cerca també. El camp fa
  1,75 rem d'alçada i els seus botons, 2 rem. Al 200 % a 1025 px, i al 100 %
  entre 769 i 1024 px, el camp s'encongeix entre el menú i el final de la banda,
  sense desplaçament horitzontal.
- **La llista de converses** conserva el selector de carpeta i els botons de la
  capçalera, que ja no s'amaguen mentre es cerca.
- **Cadenes:** `shell.region.search`, `search.band.calendar`, `search.band.chat`,
  `search.band.close` i `attachmentsView.search`, noves en els 20 catàlegs. Se
  n'han tret `attachmentsView.searchName` («Nom del fitxer») i
  `kanban.searchBoardAction` («Cerca al tauler», el botó de la capçalera del
  tauler), que ja no fa servir res.

## El final de la banda (#345)

Peça 13c. ADR-0068 §2 («Al final») i la seva decisió 8: l'estat de la
sincronització a la banda, només amb els textos d'avui i sense «Sincronitzat».
Decisió 1 del propietari a
[#342](https://github.com/adilelhaji/oreneta/issues/342): l'indicador del mode
No molestis també es va quedar a la barra vertical fins a la peça 14 (va passar a
#354).

- **Què hi ha:** l'indicador del mode No molestis, només mentre les
  notificacions estan en silenci, i després, a la vora final, l'estat de la
  sincronització. El final ocupa com a màxim el 35 % de l'amplada de la banda,
  perquè el camp de cerca hi conservi l'espai: un resum que no hi cap acaba en
  «…» i es llegeix sencer al nom accessible i a la indicació. Al 100 %, a
  1025 px, el resum hi cap sencer en català, anglès, alemany, castellà i
  francès; al 200 % s'escurça.
- **L'estat de la sincronització** (`SyncStatus`) és un botó amb una icona i el
  resum que ja mostrava la regió d'avui. Els únics textos són els d'avui:
  - «{count} requereixen atenció»: els comptes que han de tornar a iniciar la
    sessió, els que tenen una fallada (encara que s'hagi descartat) o una
    sol·licitud sense confirmar, i el problema que no té compte;
  - si no, «Estat de la sincronització completa desconegut».

  Mai «Sincronitzat»: no hi ha cap senyal que ho demostri
  ([account-sync-health.md](account-sync-health.md)). Una sol·licitud en curs no
  canvia el resum, com abans; la diu el detall del compte.
- **La icona** és un triangle d'avís quan alguna cosa requereix atenció i, si
  no, les dues fletxes de la sincronització, que no afirmen res. En el cas
  destacat (vegeu [La barra](#la-barra-sota-la-capçalera)), el botó pren el to
  de perill de la barra, el text de perill sobre el to suau, que tots els temes
  mantenen a 4,5:1 o més.
- **Amplades:** a partir de 1025 px, la icona i el resum; per sota, també per
  sota de 769 px, només la icona, amb el resum com a nom accessible i com a
  indicació (`title`).
- **Una sola regió en directe:** la regió `role="status"` d'avui (cortesa,
  `aria-live="polite"`, i sencera, `aria-atomic`) és al costat del botó, amb el
  mateix resum i visualment oculta a totes les amplades: a partir de 1025 px el
  resum que es veu és el del botó. És a la banda abans de qualsevol canvi, hi
  hagi la barra o no, i per això cada canvi s'anuncia una sola vegada, com
  abans, sense moure el focus. El resum de la barra ja no és una regió en
  directe.
- **Mai inerta:** per sota de 769 px, quan el camp de cerca cobreix la banda,
  només en són inerts els controls (el botó i la finestra emergent); la regió
  continua a l'arbre d'accessibilitat i anuncia una fallada que arriba mentre
  s'escriu.
- **Si no hi ha cap compte ni cap problema sense compte,** no es mostra res, com
  abans.

### La finestra emergent

- El botó (`aria-haspopup="dialog"`, `aria-expanded`) obre el detall d'avui: la
  nota de la sessió i cada compte, amb la seva observació i les seves accions
  («Configuració del compte» o, si la fallada era del servidor intermediari,
  «Configuració de xarxa» o la del servidor intermediari del compte; «Torna-ho a
  provar»; «Descarta»), i el problema sense compte. És una finestra no modal
  (`role="dialog"` sense `aria-modal`), amb el nom «Sincronització dels comptes»
  (`connectivity.health.title`), i no és cap punt de referència.
- **Posició:** sota el botó, amb la vora final a la vora final del botó: com que
  el botó acaba la banda, s'obre cap a l'inici de la línia, cap a l'esquerra o,
  en àrab, cap a la dreta (`endAlignedX` i `menuLeft`). Fa 24 rem d'amplada, mai
  més ampla que la finestra menys 8 px a cada costat, i com a màxim l'alçada que
  queda fins a 8 px de la vora inferior; la resta es desplaça. No es talla ni
  entre 769 i 1024 px ni per sota de 769 px.
- **Focus:** en obrir-se, amb el ratolí o amb el teclat, el focus va a la
  finestra, i Tab en recorre les accions. Escapada la tanca i torna el focus al
  botó. També la tanquen un segon clic al botó, un clic fora i el focus en un
  altre lloc (Tab més enllà de l'última acció, F6), que deixen el focus on ha
  anat, i un desplaçament de la pàgina o un canvi de mida de la finestra, que
  tornen al botó el focus que hi havia a dins.
- **Les accions** fan el mateix que a la barra. La que obre la configuració
  tanca primer la finestra amb el focus al botó, i la configuració l'hi torna en
  tancar-se. «Descarta» i «Torna-ho a provar» deixen el focus a l'entrada, que
  continua a la finestra: mentre la sol·licitud és en curs, «Torna-ho a provar»
  està desactivat, i el focus no cau a la pàgina, on una tecla nua actuaria sobre
  la conversa. A la barra, «Torna-ho a provar» també deixa el focus a l'entrada,
  però la barra no reté les tecles nues, com abans.
- **Tecles:** una drecera amb Ctrl/⌘, Alt o una tecla de funció (la paleta, F6)
  actua des del botó, amb la finestra tancada, com al menú de l'aplicació. Les
  altres tecles (una lletra, les fletxes, Supr) es queden a la finestra: no
  arriben a la llista ni a la conversa del darrere.

### La barra sota la capçalera

- La barra d'amplada completa d'avui (`ConnectivityBanner`) només hi és en el
  cas destacat: quan un compte ha de tornar a iniciar la sessió, o quan hi ha
  una fallada, o un problema sense compte, que no s'ha descartat. Es queda fins
  que es resol o es descarta, i una sessió que s'ha de tornar a iniciar no es
  pot descartar. Fora d'aquest cas, la barra no hi és: ho diu la banda.
- És la d'avui: la regió «Sincronització dels comptes», amb el to de perill, el
  seu botó, el resum i el detall, que s'obre a sota. Mentre la finestra emergent
  és oberta, la barra plega el seu detall, en el mateix pintat en què la
  finestra apareix: no n'hi ha mai dos, i les sol·licituds s'anuncien una sola
  vegada.
- Si la barra se'n va amb el focus a dins (s'hi ha descartat l'última fallada),
  el focus passa al botó de la banda, que encara diu el que se sap, en lloc de
  quedar a la pàgina.

### El mode No molestis

- **A la banda:** el mateix indicador que tenia la barra vertical, amb el mateix estat
  (`useQuietState`) i els mateixos textos: «No molestis fins a…», «El mode No
  molestis està activat fins que el desactivis» o «Hores de silenci fins a…». Un
  botó amb la campana barrada, en el to d'avís sobre el to suau, i un clic
  reprèn les notificacions. Hi és a totes les amplades, també per sota de
  769 px, on la barra vertical no es veia.
- **A la barra vertical,** fins a la peça 14, es veia el mateix botó: tots dos
  llegien el mateix estat, i apareixien, canviaven i se n'anaven alhora. El de la
  banda és la regió `role="status"` amb el nom de l'estat; el de la barra
  vertical era només el botó, amb l'estat a la indicació, perquè un lector de
  pantalla no trobés l'estat dues vegades. Des de #354 la barra vertical no hi és
  i l'indicador de la banda és l'únic. Quan la cerca cobreix la banda, a la banda
  només el botó és inert, no la regió d'estat.

### Teclat, F6, dreta a esquerra i zoom

- El final és dins de la regió `search`. Tab va del botó del menú al camp de
  cerca i als seus botons i, després, a l'indicador del mode No molestis i al
  botó de l'estat. F6 des de la finestra emergent la tanca i passa a la regió
  següent; Maj+F6 torna al botó.
- En àrab, el final de la banda és a l'esquerra, i la finestra s'obre des del
  botó cap a la dreta.
- Al 200 % de l'aplicació a 1025 px, el final no passa del 35 % de la banda, el
  camp de cerca hi conserva més de 100 px i la finestra emergent queda dins de
  la finestra, sense desplaçament horitzontal.
- **La pantalla d'alta del primer compte** no té el final: no hi ha cap compte
  per sincronitzar ni del qual rebre notificacions. És el criteri del menú i del
  camp de cerca en aquesta pantalla.
- **Cadenes:** cap de nova; el botó, la regió, la finestra i la barra fan servir
  les d'avui (`connectivity.health.*`, `notifications.dnd.*`).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`components/palette/paletteCommands.test.ts`) | L'ordre de les àrees, cada ordre una sola vegada, l'ordre dins d'una àrea i les accions abans de les seccions |
| N2 (`components/palette/useCommandList.test.tsx`) | Cada ordre té una àrea i un identificador únic; els mòduls, la paleta, «Quant a» i el mode No molestis; les destinacions del correu des d'un altre mòdul (un compte, un tauler, una carpeta i un tauler nou), i cap marcada des d'un altre mòdul; «Paleta d'ordres» només al menú; sense compte, només la configuració, els temes i l'aplicació; els sinònims en anglès i en català |
| N2 (`components/shell/AppHeader.test.tsx`) | La capçalera «Oreneta» i la banda (`search`, `h-9`, tres zones); el menú amb totes les ordres per àrea i el menú «Més»; els elements de ràdio; executar una ordre; una ordre desactivada, amb el motiu com a descripció; el teclat (també Amunt) i el retorn del focus; Avall i Amunt al botó i les fletxes del menú no mouen la selecció de la llista ni del tauler, i cap de les tecles que gestionen el botó i el menú no arriba a la finestra; Ctrl/⌘+K des del menú torna el focus al botó; «Paleta d'ordres» al menú i no a la paleta; el menú sense compte; com es tanca; la posició en les dues direccions i en una finestra estreta; els noms en els 20 catàlegs |
| N2 (`components/setup/SetupScreen.test.tsx`) | La banda a la pantalla d'alta, damunt de `<main>` (`content`); F6 i Maj+F6; la configuració i la paleta des del menú i des del teclat; el zoom; les dreceres del correu (Ctrl/⌘+N no s'hi consumeix) i les fletxes no hi actuen; el «+» de la configuració torna a l'alta sense canviar-la; la configuració continua oberta, amb el focus, quan arriba el primer compte, i el torna al botó del menú en tancar-se |
| N2 (`lib/useDialogFocus.test.tsx`) | En tancar-se, un diàleg torna el focus al control que l'havia obert, també quan havia caigut al cos de la pàgina; el focus que ha pres un altre control s'hi queda |
| N1 (`lib/regions.test.ts`) | La banda és la primera regió, i des del menú F6 passa a la regió següent |
| N2 (`components/menu/Menu.test.tsx`, `lib/menuKeyboard.test.ts`) | `tabStop`; el desplaçament fins a la fila sencera |
| N2 (`components/shell/BandSearch.test.tsx`, #344) | El punt de referència «Cerca» al centre de la banda i el nom del camp a cada mòdul; escriure-hi canvia l'estat de cada mòdul, i cada mòdul conserva la seva consulta en canviar; esborrar; al correu, Escapada, els operadors, els canals sense constructor, el constructor i les cerques desades des del final del camp; al tauler, l'abast i Escapada; el Calendari i el Xat desactivats amb el motiu; els retards de Notes (200 ms), Persones (150 ms) i Adjunts (200 ms) i el filtre de Tasques, amb els textos de «cap resultat»; Ctrl/⌘+Maj+F, la `/`, Ctrl/⌘+F (també en un altre mòdul amb una conversa triada al correu) i les ordres de la paleta; el camp no pren el focus en aparèixer; per sota de 769 px, el botó, el camp damunt de la banda, la banda `inert`, Escapada, «Tanca la cerca» i el focus quan la finestra s'estreny; el camp damunt de la banda es tanca en passar al Calendari o al Xat, amb el focus al botó si era al camp; una petició de focus que no es pot atendre es descarta; la banda no es torna a pintar per un canvi dels comptes que no la toca; esborrar a Persones, a Tasques i a Adjunts; «Cerca» al menú d'una columna del tauler; les ordres de cerca de la paleta i del menú porten al correu des del Calendari i des de Notes; la pantalla d'alta sense camp; els noms i les cadenes en els 20 catàlegs |
| N1 (`states/kanban.test.ts`, #344) | `setKanbanSearchScope` tria l'abast de la cerca del tauler i desplega la columna plegada; «totes les columnes» i un abast que no és cap columna no toquen cap columna |
| N2 (`components/chat/MessagePaneThreadSearch.test.tsx`, #344) | Amb StrictMode, «Cerca a la conversa actual» des de Notes passa al correu i la subfinestra de la conversa n'obre la cerca després del seu reinici repetit; una petició per a una altra conversa no obre res i es descarta; ni una altra conversa ni tornar al correu no la tornen a obrir |
| N2 (proves dels mòduls, #344) | `AppHeader.test.tsx`, `TaskLists.test.tsx` i `PeopleView.test.tsx` escriuen al camp de la banda; `NotesFolderPane`, `PeopleFolderPane`, `TasksFolderPane` i `AttachmentsFolderPane` comproven que el mòdul ja no té el camp, i les proves de #341 fan servir un altre control que no es mou (o, a Adjunts, el remitent) |
| e2e (`startup.e2e.ts`, «#343») | La banda i el menú a 1440, 1025, 1024 i 768 px; el teclat i el ratolí, amb la mateixa conversa oberta després d'Avall, d'Amunt i de les fletxes del menú; Ctrl/⌘+K des del menú; executar la configuració, un mòdul, un compte, el mode No molestis, «Quant a» i la paleta; el motiu d'una ordre desactivada com a descripció; el menú «Més» de la barra vertical; l'àrab amb axe i el menú obert a 1440 i a 768 px; el 200 % a 1025 px; la pantalla d'alta amb la banda, el menú, F6, el zoom i axe, en anglès i en àrab; el «+» de la configuració a la pantalla d'alta; una còpia de seguretat restaurada des de la configuració a la pantalla d'alta, amb la configuració oberta i el focus de tornada al botó del menú. El recorregut d'F6 de «#306» comença a la banda |
| e2e (`startup.e2e.ts`, «#344») | Cercar des de la banda al correu (la consulta de `mail.threadList`, Escapada, el constructor i les cerques desades), en un tauler (l'abast, «Cerca» al menú d'una columna i Escapada), a Notes, a Persones, a Tasques i a Adjunts, i cada mòdul amb la seva consulta; el camp d'Adjunts conserva el focus i el text en travessar els 1025 px; el Calendari i el Xat desactivats amb el motiu, amb axe; Ctrl/⌘+Maj+F, Ctrl/⌘+F (amb una conversa oberta i sense, i en un altre mòdul) i la `/`; a 768 px, el botó, el camp damunt de la banda, axe, Escapada, «Tanca la cerca» i F6, i el camp que es tanca en passar al Calendari des de la paleta; l'àrab amb axe a 1440 px (també al Calendari) i a 768 px; el 200 % a 1025 px i 1024, 900 i 769 px al 100 %, sense desplaçament horitzontal. Els recorreguts d'F6 de «#306» escriuen al camp de la banda, i les proves d'Adjunts de «#339» i «#341» el fan servir per al nom del fitxer |
| N2 (`components/shell/SyncStatus.test.tsx`, #345) | Res sense cap compte i el botó amb el primer; el resum de cada estat (desconegut, atenció, sol·licitud en curs, sense confirmar, fallada, sessió per tornar a iniciar, problema sense compte), mai «Sincronitzat», en els 20 catàlegs; una sola regió en directe, sense moure el focus; la icona sola per sota de 1025 px, amb el nom i la indicació, i en travessar els 1025 px; la finestra emergent: el detall, el focus, Escapada, un segon clic, un clic fora, el focus fora, un desplaçament de la pàgina i un canvi de mida, la configuració amb el focus de tornada al botó, les tecles, la posició en les dues direccions i a 900, 768 i 320 px; la barra només en el cas destacat, sense regió en directe, el focus al botó quan se'n va, una sessió que no es pot descartar, el problema sense compte i el detall plegat amb la finestra oberta; el mode No molestis a la banda i a la barra vertical, una sola regió d'estat; l'ordre de Tab; cap punt de referència nou; la pantalla d'alta sense el final; per sota de 769 px, amb la cerca damunt de la banda, les dues regions d'estat fora de cap element inert i els controls inerts; «Torna-ho a provar» deixa el focus a l'entrada, a la finestra i a la barra, i una tecla nua no surt de la finestra; la barra plega el seu detall en el mateix pintat en què apareix la finestra |
| e2e (`startup.e2e.ts`, «#345») | El final de la banda a 1440, 1025, 1024 i 768 px: el resum o la icona sola, una sola regió en directe, la finestra emergent amb el ratolí, dins de la finestra, Escapada i els clics; el teclat: Tab des del botó del menú, Retorn, Espai, Escapada, F6 i Maj+F6, i la configuració amb el focus de tornada al botó; una fallada torna la barra, a 1440 i 768 px, que plega el seu detall amb la finestra oberta i se'n va en descartar-la, i una sessió per tornar a iniciar no es pot descartar, amb les regles de regions d'axe; l'àrab amb axe i la finestra oberta a 1440 i 768 px; el 200 % a 1025, 1024, 900 i 769 px amb el mode No molestis activat; el mode No molestis a la banda a 1440 i 768 px. Les proves de «#343», de l'actualització manual i de les observacions de la sincronització busquen l'estat a la banda, i la barra només quan hi ha una fallada; la del mode No molestis troba la regió d'estat a la banda; a 768 px, amb la cerca damunt de la banda, una fallada s'anuncia: les dues regions d'estat són a l'arbre d'accessibilitat de Chromium i els controls no; «Torna-ho a provar» deixa el focus a l'entrada, a la finestra i a la barra, i la `j` no mou la conversa oberta |
| N2 (`baseline/connectivityHealth.test.tsx`) | L'anunci d'una fallada sense moure el focus, ara des del botó de la banda (#345) |

## Sense la barra vertical (#354)

Peça 14b ([mail-navigation.md](mail-navigation.md#la-tira-de-mòduls-i-la-barra-estreta-la-barra-vertical-sen-va-354)):
la barra vertical se'n va, amb el seu menú «Més» i la seva còpia de l'indicador
del mode No molestis, i els mòduls passen a la tira de mòduls i a la barra
estreta. Decisió 3 del propietari a
[#352](https://github.com/adilelhaji/oreneta/issues/352): també se'n van els
menús «Més» de per sota de 769 px, a `CompactNavigation` i a la capçalera de la
llista estreta, amb `QuickSettingsMenu`; la fletxa per tornar al correu es manté.

- **El menú de l'aplicació és on és tot:** cada element del menú «Més» de la
  barra vertical hi és una vegada: «Ves a: …» per a cada mòdul, «Paleta d'ordres»,
  «Afegeix un compte», «Crea un tauler kanban», «Sincronitza la bústia», les tres
  pauses del mode No molestis o «Reprèn les notificacions», «Obre la configuració» i
  «Quant a Oreneta». El clic dret sobre la barra buida, que obria aquest menú, no
  té substitut propi: el contingut és al botó del menú de l'aplicació.
- **Sincronitzar mentre se sincronitza:** el menú «Més» deia que hi havia una
  comprovació del correu en curs i no en deixava demanar una altra. Ara ho fa
  l'ordre «Sincronitza la bústia» (`mail.sync`), al menú de l'aplicació i a la
  paleta: desactivada mentre `ui$.busy` i amb el motiu, «S'està sol·licitant una
  comprovació del correu…», com a indicació i com a descripció accessible, com
  qualsevol ordre que no es pot fer.
- **Un tauler nou** es crea de seguida amb el nom per defecte i es mostra al correu,
  com ja feia l'ordre de la paleta (decisió del propietari a #352, a tot arreu); el
  diàleg del nom de la barra vertical (`BoardDialog`) se'n va amb ella.
- **Per sota de 769 px,** on no hi ha selector de mòduls, els mòduls s'obren des
  del menú de l'aplicació, i el focus torna al seu botó.
- **El mode No molestis:** l'indicador de la banda és l'únic, a totes les
  amplades.
- **Proves:** les de «#343» i «#345» que trobaven el menú «Més» o l'indicador de
  la barra vertical els busquen ara al menú de l'aplicació i a la banda, i
  comproven que no hi ha cap més botó «Més» (la tira en té un només quan no hi
  caben tots els mòduls); l'ordre del menú de l'aplicació executa també afegir un
  compte, crear un tauler, sincronitzar i la configuració.
  `baseline/manualRefreshUi.test.tsx` comprova l'ordre de sincronitzar en curs
  al menú de l'aplicació, i `components/sidenav/QuietIndicator.test.tsx`, les
  pauses del mode No molestis.

## Pendent

- El to «marc» (#287).
- L'evidència nativa (N4) i amb lectors de pantalla continua pendent (#37).
