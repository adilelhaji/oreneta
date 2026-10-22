# Banda superior i menú de l'aplicació (#343)

Peça 13a del redisseny, pas 3 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §2 i §9). Les
decisions del propietari per a tota la peça 13 consten a
[#342](https://github.com/adilelhaji/oreneta/issues/342): la barra vertical
conserva el menú «Més» i l'indicador de no molestar fins a la peça 14, i la peça
es lliura en tres PR (13a, la banda i el menú; 13b, la cerca, #344; 13c, l'estat
de la sincronització i el no molestar a la banda, #345).

Codi: `frontend/src/components/shell/AppHeader.tsx`,
`components/shell/AppMenu.tsx`, `components/palette/paletteCommands.ts`
(`area`, `COMMAND_AREAS`, `groupCommandsByArea`),
`components/palette/useCommandList.ts` i `App.tsx`.

## La capçalera i la banda

- **On és:** dins de la finestra, sota la barra de títol del sistema (a macOS,
  sota `MacTitleBar`, sense cap patró nou de Wails) i damunt dels avisos
  (`ConnectivityBanner`, `UpdateBanner`), fora de `<main>`. És l'ordre d'ADR-0068
  §1: barra de títol, capçalera, avisos i la resta.
- **Capçalera:** un `<header>` (`banner`) amb el nom «Oreneta», que és el nom de
  l'aplicació i no es tradueix (`shell.region.banner`, igual en els 20 catàlegs).
  La banda n'és la primera fila; la barra d'eines principal (§3) en serà la
  segona quan existeixi la primitiva de la peça 8.
- **Banda:** 2,25 rem d'alçada (`h-9`), és a dir, 36 px al 100 % i 72 px al 200 %
  de l'aplicació, amb el to del marc d'avui (`--me-bg-header`) fins que #287 hi
  posi el to «marc», i un divisor a sota. Té tres zones en fila: l'inici, amb el
  botó «Menú de l'aplicació»; el centre, que ocupa l'espai que queda i on anirà el
  camp de cerca (13b); i el final, on aniran l'indicador de no molestar i l'estat
  de la sincronització (13c). De moment, el centre i el final són buits.
- **Totes les amplades:** la banda i el botó es veuen a qualsevol amplada, també
  per sota de 769 px; el botó de cerca i la icona de l'estat hi arriben amb 13b i
  13c.
- **Regió d'F6:** la banda és la regió `search`, la primera de `REGION_ORDER`
  (vegeu [app-regions.md](app-regions.md)); F6 hi porta el focus al botó del menú.
  13b hi afegeix el camp sense canviar la regió.
- La pantalla d'alta del primer compte no té banda: continua sense marc, com
  abans.

## El menú de l'aplicació

- **Botó:** «Menú de l'aplicació» (`appMenu.label`), amb `aria-haspopup="menu"` i
  `aria-expanded`. El nom és diferent del «Més» de la barra vertical en tots els
  catàlegs.
- **Contingut:** totes les ordres de la paleta (`useCommandList`), cadascuna una
  sola vegada, agrupades per àrea (`MenuGroup`, amb el títol de l'àrea com a nom
  del grup). No hi ha cap segona llista: el que el menú «Més» de la barra vertical
  tenia i la paleta no, ara és a `useCommandList`, i per això la paleta també ho
  té.
- **Àrees**, en aquest ordre (`COMMAND_AREAS`):

  | Àrea | Títol | Ordres |
  |---|---|---|
  | `modules` | Mòduls | «Ves a: Correu» i un «Ves a: …» per a cada mòdul |
  | `mail` | Correu | Redactar, l'enviament personalitzat, els pendents de resposta, sincronitzar, marcar-ho tot com a llegit, les dues cerques i els tres filtres |
  | `conversation` | Conversa | Respondre, l'editor complet, arxivar, destacar, marcar com a no llegit, suprimir i tancar la pestanya, només quan escau |
  | `accounts` | Comptes | Afegir un compte, la safata unificada i cada compte |
  | `folders` | Carpetes | Cada carpeta del compte |
  | `boards` | Taulers | Crear un tauler kanban i cada tauler |
  | `theme` | Tema | Cada tema |
  | `notifications` | Notificacions | Les tres pauses de no molestar o «Reprèn les notificacions» |
  | `settings` | Configuració | «Obre la configuració» i, després, cada secció que pot obrir |
  | `app` | Aplicació | La paleta d'ordres, les dreceres de teclat, el catàleg de disseny i «Quant a Oreneta» |

  Dins d'una àrea, les accions van abans que les seccions de la configuració, i
  cada tipus conserva l'ordre de la llista. La paleta no fa servir les àrees.
- **El menú «Més» de la barra vertical** es troba també al menú de l'aplicació:
  els mòduls, la paleta, afegir un compte, afegir un tauler, sincronitzar, el no
  molestar, la configuració i «Quant a». Afegir un compte, afegir un tauler,
  sincronitzar i la configuració ja eren ordres de la paleta i hi surten una sola
  vegada, amb el que fa la paleta: afegir un tauler el crea amb el nom per defecte,
  com «Crea un tauler kanban», sense el diàleg del nom de la barra vertical.
- **Ordres noves de la paleta:** un «Ves a: …» per a cada mòdul (ADR-0068 §5), la
  paleta d'ordres, «Quant a Oreneta» i les del no molestar, amb els sinònims als
  catàlegs (`commands.aliases.module`, `.palette.open`, `.app.about` i
  `.notifications`).
- **Destinacions del correu des d'un altre mòdul:** «Ves a: Correu», un compte, un
  tauler o una carpeta tornen al correu, com fa la barra vertical. Abans, des del
  Calendari, la paleta canviava la selecció del correu sense mostrar-la. «Ves a:
  Correu» només es marca al correu sense cap tauler obert.
- **Estat:** les ordres que mostren un estat (el mòdul, el tema, el filtre, el
  compte, la carpeta, el tauler) són `menuitemradio` amb `aria-checked`, i la
  marcada té el text en el color d'accent i una marca al final. Les altres són
  `menuitem`. Una ordre que no es pot fer (en un compte de només lectura) és
  `aria-disabled`, no fa res i diu per què a la indicació, amb el text de la
  paleta. Les dreceres es mostren al final de la fila i no formen part del nom.
- **Executar una ordre:** primer el focus torna al botó i després s'executa
  l'ordre, com fa la paleta. Així, un diàleg que s'obri (la configuració, «Quant
  a», la paleta) torna el focus al botó en tancar-se, i una ordre que mou el focus
  (la cerca, la resposta) el pren des del botó.

## Teclat i focus

- Retorn, Espai o Avall l'obren amb el focus al primer element; Amunt, Avall,
  Inici, Fi i la cerca per lletra són els de la [primitiva de menús](menus.md).
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
- Fa 20 rem d'amplada, mai més que la finestra menys 8 px a cada costat, i com a
  màxim l'alçada que queda fins a 8 px de la vora inferior; la resta es desplaça.
  Les mides són en píxels sencers, perquè l'última fila no quedi tallada per mig
  píxel.
- Al 200 % de l'aplicació la banda fa 72 px. A 1025 px, aquesta alçada surt de les
  subfinestres: la pàgina no es desplaça i els controls dels límits del correu
  continuen dins de l'alçada de la finestra.
- **Límit conegut, anterior a la banda:** al 200 % i a 1025 px, «Més accions» de
  la capçalera de la conversa ja quedava en part fora de la vora final. La banda
  no mou res cap als costats; la barra d'eines principal (§3) és la peça que
  canvia aquesta capçalera.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`components/palette/paletteCommands.test.ts`) | L'ordre de les àrees, cada ordre una sola vegada, l'ordre dins d'una àrea i les accions abans de les seccions |
| N2 (`components/palette/useCommandList.test.tsx`) | Cada ordre té una àrea i un identificador únic; els mòduls, la paleta, «Quant a» i el no molestar; les destinacions del correu des d'un altre mòdul; els sinònims en anglès i en català |
| N2 (`components/shell/AppHeader.test.tsx`) | La capçalera «Oreneta» i la banda (`search`, `h-9`, tres zones); el menú amb totes les ordres per àrea i el menú «Més»; els elements de ràdio; executar una ordre; una ordre desactivada; el teclat i el retorn del focus; com es tanca; la posició en les dues direccions i en una finestra estreta; els noms en els 20 catàlegs |
| N1 (`lib/regions.test.ts`) | La banda és la primera regió, i des del menú F6 passa a la regió següent |
| N2 (`components/menu/Menu.test.tsx`, `lib/menuKeyboard.test.ts`) | `tabStop`; el desplaçament fins a la fila sencera |
| e2e (`startup.e2e.ts`, «#343») | La banda i el menú a 1440, 1025, 1024 i 768 px; el teclat i el ratolí; executar la configuració, un mòdul, un compte, el no molestar, «Quant a» i la paleta; el menú «Més» de la barra vertical; l'àrab amb axe i el menú obert a 1440 i a 768 px; el 200 % a 1025 px. El recorregut d'F6 de «#306» comença a la banda |

## Pendent

- 13b (#344): el camp de cerca al centre de la banda.
- 13c (#345): l'indicador de no molestar i l'estat de la sincronització al final.
- Peça 14: la barra vertical se'n va, amb el seu menú «Més» i el seu indicador.
- El to «marc» (#287).
- L'evidència nativa (N4) i amb lectors de pantalla continua pendent (#37).
