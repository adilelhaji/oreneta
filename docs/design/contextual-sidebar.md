# Barra lateral contextual (#86)

El panell Conversa de la barra lateral de l'aplicació (des de #361; abans, la barra
lateral de detalls d'una conversa), amb la multimèdia, els fitxers i els
participants, afegeix «Historial amb …» per a cada participant.

- **Què mostra:** les converses amb aquella adreça, les reunions properes en què
  és (organitzador o assistent) i els fitxers que ha enviat. Cada element obre
  el seu origen: la conversa, el dia al calendari o el missatge del fitxer.
- **Aïllament:** només el compte de la conversa oberta. Un altre compte que
  tingui correu de la mateixa persona no hi apareix, i una resposta lenta per al
  compte anterior no es pinta al nou.
- **Adreça completa:** `ana@x.test` no coincideix amb `diana@x.test`. La
  consulta filtra per subcadena i després es comprova l'adreça exacta.
- **El que hi ha aquí:** s'indica de quants missatges desats surt i quants
  tenen el cos baixat, perquè l'historial antic pot faltar.
- **Nucli:** `meron-core/src/person_context.rs`, RPC `context.person`.

## Proves

- **Nucli:**
  - una conversa per fil, la més recent primer;
  - sense la Diana i sense un altre compte;
  - reunions futures, sense les passades ni les cancel·lades.
- **Aplicació:**
  - cada element obre el seu origen;
  - avís d'historial parcial;
  - una resposta tardana d'un altre compte no hi apareix.

## Agenda, amplada i secció recordada (#212, ADR-0059)

- **Agenda:** panell de la barra lateral (fins a #361, una secció de la barra de
  detalls) amb els esdeveniments dels calendaris activats
  i les tasques amb data dels pròxims 7 dies; les tasques vençudes, primer. Els
  esdeveniments de dia sencer van per la seva data, no per l'hora UTC en què es
  desen. Cada element obre l'esdeveniment (el calendari al seu dia) o la tasca
  (el seu editor). Si una font no es llegeix, ho diu; si el servidor d'un
  compte no s'actualitza, avisa que pot estar desactualitzada fins que una
  sincronització de la setmana ho aconsegueixi. Es rellegeix en sincronitzar,
  en tancar l'editor de tasques i a mitjanit.
- **Límit, fins a #361:** a l'agenda només s'hi arribava des de la barra lateral
  d'una conversa oberta, i no hi havia cap tauler de ginys independent (en
  arrencar sense conversa, ni a Calendari, Tasques, Contactes o Notes). Des de
  #361 és un panell de la barra lateral de l'aplicació, a tots els mòduls i sense
  conversa oberta (vegeu [La barra lateral de
  l'aplicació](#la-barra-lateral-de-laplicació-361)). La fila SET-23 no canvia
  d'estat amb aquesta peça: és una nota d'evidència del registre d'acceptació.
- **Amplada:** entre 280 i 560 px, amb el teclat o arrossegant el separador, i es
  desa entre reinicis (`details_panel_width`). Des de #361, quan la barra va al
  costat del contingut o a sobre ho decideix la regla d'ADR-0069 §2 (vegeu més
  avall); abans anava al costat del lector amb una finestra de 1100 px o més i
  una fila amb espai per a 280 px més els 360 px del lector, i si no era una capa
  sobre el lector. La llista de converses i el tauler del kanban fan servir el
  mateix separador, que indica la mida dibuixada i segueix la direcció de
  lectura.
- **Panell recordat:** es torna a obrir a l'últim que s'ha fet servir, també
  després de reiniciar (`session_sidebar_section_main`). Des de #361 aquesta
  clau desa el tipus de panell (vegeu més avall). L'historial d'una persona no es
  recorda. Fins a #361, si la barra era oberta o tancada només es recordava durant
  la sessió; ara es desa (`app_sidebar_state`).
- **Proves:** `lib/agenda.test.ts`, `lib/paneResize.test.ts`,
  `SidebarAgenda.test.tsx`, `PaneResizer.test.tsx`,
  `ConversationDetailsPanel.test.tsx` (des de #361, amb el contenidor nou) i
  l'entrada de producció (600, 1024, 1100, 1180 i 1440 px, mode clar i fosc,
  200 %).

## La barra lateral de l'aplicació (#361)

Peça 12a del redisseny i pas 5 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§9), segons
[ADR-0069](../adr/0069-barra-lateral-de-tota-l-aplicacio.md) (§1, §2 i §5). Les
decisions del propietari consten a
[#360](https://github.com/adilelhaji/oreneta/issues/360): la peça va en tres PR
(12a, el contenidor amb els panells Agenda i Conversa; 12b, el panell Dia; 12c,
el panell Persona), i el botó «Barra lateral» va al final de la banda superior
fins que hi hagi la barra d'eines principal.

Codi: `frontend/src/components/shell/AppSidebar.tsx` (el contenidor),
`components/shell/SidebarToggle.tsx` (el botó de la banda),
`components/shell/useSidebarShown.ts`, `states/sidebar.ts` (què es mostra i què
canvia l'estat desat), `lib/paneResize.ts` (`appSidebarLayout`, la regla del
§2), `components/chat/ConversationDetailsPanel.tsx` (el contingut del panell
Conversa), `components/chat/activeConversation.ts` (la conversa oberta, la
mateixa que llegeix `MessagePane`), `states/settings.ts` (`app_sidebar_state`) i
`states/ui.ts` (`session_sidebar_section_main`).

### On és i què hi ha

- **Un sol `<aside>`:** «Barra lateral» (`sidebar.label`), al final de la fila
  del marc, després de `<main>`, a tots els mòduls. És la regió `sidebar` d'F6.
  Substitueix la barra lateral de detalls com a contenidor: no n'hi ha dues, i
  el lector (`MessagePane`) ja no la mostra. `<main>` encara
  conté la subfinestra de carpetes i la barra estreta de mòduls (vegeu
  [app-regions.md](app-regions.md)).
- **Panells:**

  | Panell | Contingut | On n'hi ha |
  |---|---|---|
  | Agenda | El d'ADR-0059, sense canvis | Tots els mòduls |
  | Conversa | El resum (els participants), la multimèdia i els fitxers, i l'historial d'una persona a sobre, com abans | Correu i taulers, amb una conversa oberta |

  Dia i Persona arriben amb les peces 12b i 12c; fins aleshores no tenen
  pestanya ni icona. Afegir un panell és una entrada a la llista `SIDEBAR_PANELS` de
  `AppSidebar.tsx`. L'agenda ja no és una fila del resum: és un panell.
- **Selector de panells**, al peu, de 2,5 rem: una llista de pestanyes
  (`tablist`, «Panells de la barra lateral»). Les fletxes esquerra i dreta
  passen a la pestanya següent o a l'anterior en el sentit de lectura, en bucle,
  i Inici i Fi van als extrems; cada pestanya és una parada de Tab (ADR-0061).
  Sense conversa oberta, la pestanya Conversa no hi és; no es mostra
  desactivada.
- **Panell recordat:** `session_sidebar_section_main` desa el tipus de panell,
  mai la persona: `overview`, `media` o `files` (el panell Conversa en aquella
  subsecció), `agenda`, i els valors nous `day` i `person`. En llegir-lo:

  | Valor desat | Amb una conversa oberta | Sense conversa oberta |
  |---|---|---|
  | `overview`, `media`, `files` | Conversa, en aquella subsecció | Agenda |
  | `agenda` | Agenda | Agenda |
  | `day`, `person` | Agenda fins que hi hagi els panells; el valor es conserva | Agenda |
  | desconegut o buit | Agenda | Agenda |

  La pestanya Conversa torna a la subsecció que s'hi va veure l'última vegada en
  la sessió.

### Estats i què es desa

- **Tres estats**, a la preferència nova `app_sidebar_state`:
  - `expanded`, desplegada: al costat del contingut, amb l'amplada
    `details_panel_width` (280–560 px) i el separador d'ADR-0059, i al
    capdamunt el nom del panell i el botó «Minimitza la barra lateral»;
  - `minimized`, minimitzada (per defecte, en un perfil nou i en actualitzar):
    una tira de 2,5 rem (40 px al 100 %) amb la icona de cada panell; una icona
    desplega la barra en aquell panell. Les icones es diuen «Obre el panell
    Agenda» i «Obre el panell Conversa», i no només com el panell: el Calendari ja
    té un botó «Agenda», el de la seva visualització;
  - `hidden`, amagada: no es dibuixa res.
- **Què canvia l'estat desat:** el botó «Barra lateral» de la banda superior,
  les icones de la tira, el botó de minimitzar i la tecla `i`, quan la barra va
  al costat del contingut. Obrir o tancar la capa (Escapada, un clic al fons, el
  botó «Tanca (Esc)», `i` o el botó de la banda quan la barra és una capa) no el
  canvia: la capa és una manera de mostrar-la on no hi cap, no una preferència.
- **En arrencar no s'obre mai una capa sola:** si l'estat desat és `expanded` i
  la barra no hi cap al costat, es dibuixa la tira (per sota de 769 px, res), i
  l'estat desat no canvia. Si la finestra s'eixampla prou, torna a ser al
  costat; si s'estreny, torna a ser la tira.

### Al costat o a sobre

- **La regla** (ADR-0069 §2, `appSidebarLayout`): la barra va al costat del
  contingut si la finestra fa almenys 1100 px i

  `resta = fila − carpetes (200, si es dibuixen) − llista (280, només al correu) − contingut (360) ≥ 280`,

  on la fila és l'amplada dibuixada sense la barra lateral. Amb un tauler obert,
  en lloc de la llista i el contingut compten la columna del tauler (280 px) i,
  si hi ha una conversa oberta, la subfinestra de conversa del tauler (360 px a
  partir de 769 px). Al costat, el màxim és `min(560, resta)`, i el separador
  anuncia aquest màxim.
- **Al correu**, amb les carpetes: a 1100 px la resta és 260 i és una capa; a
  partir de 1120 px va al costat; a 1180 px, fins a 340 px; a 1440 px, fins a
  560 px. Als altres mòduls, a 1100 px la resta és 540.
- **Qui cedeix:** primer la subfinestra de carpetes, fins a 200 px, i després la
  llista, fins a 280 px (abans la llista no cedia davant de la barra); el lector
  conserva els seus 360 px. Als altres mòduls el contingut en conserva 360
  (decisió 5 del propietari a ADR-0069), i per això també hi cedeix primer la
  subfinestra de carpetes.
- **Si no hi cap**, és una capa sobre el mòdul i la seva capçalera, de com a
  màxim el 85 % de la finestra i amb un fons, sense separador. Els diàlegs, els
  avisos i la galeria queden per sobre de la capa. La tira, quan hi és, conserva
  el seu lloc sota la capa, de manera que el mòdul no es mou.
- **La tira** sempre va al costat, a partir de 769 px. Al 200 % de l'aplicació fa
  80 px, i just per sobre de 769 px, al correu, no hi cap al costat de la barra
  estreta de mòduls (96 px), la llista (280) i el lector (360): no es dibuixa fins
  que hi cap, a uns 816 px.
- **Per sota de 769 px** no hi ha tira: la barra només s'obre com a capa, des del
  botó de la banda o del menú de l'aplicació, i en tancar-se no queda res.

### Obrir, tancar i el focus

- **El botó «Barra lateral»**, al final de la banda superior, després de l'estat
  de la sincronització, a tots els mòduls (`aria-expanded`): amb la barra
  desplegada al costat, l'amaga; amb la capa oberta, la tanca; altrament, la
  desplega, al costat si hi cap i si no com a capa. A la pantalla d'alta del
  primer compte no hi és.
- **L'ordre** «Mostra la barra lateral» o «Amaga la barra lateral», a la paleta
  i al menú de l'aplicació, a l'àrea «Aplicació», fa el mateix que el botó.
- **La tecla `i`** (`thread.details`) al correu, amb una conversa oberta: si la
  barra està desplegada al panell Conversa, la minimitza (si és una capa, la tanca
  com Escapada); si no, la desplega al panell Conversa. Els botons «Detalls de
  la conversa» de la capçalera de la conversa fan el mateix que `i`.
- **El focus:** la capa el pren, a la pestanya seleccionada, i en tancar-se el
  torna a l'element que l'havia obert (si ja no hi és, a la icona de la tira).
  Desplegar la barra des de la tira el porta a la pestanya del panell, i
  minimitzar-la, a la icona del panell a la tira. Un focus que ha pres una altra
  superfície (un diàleg obert des de l'agenda, el botó de la banda) s'hi queda.
- **La capa es tanca** també en canviar de mòdul (un esdeveniment de l'agenda
  obre el calendari), amb «Mostra a la conversa» d'una imatge o d'un fitxer, i
  amb «Missatges amb …» d'un participant, que porten a la conversa o a la llista.
- **Subfinestres de la dreta de cada mòdul:** el detall d'un esdeveniment del
  calendari és un diàleg modal, i la subfinestra de conversa del tauler és dins
  de la fila del tauler; cap no topa amb la barra.

### Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`lib/paneResize.test.ts`) | La regla a 1100, 1119, 1120, 1180 i 1440 px, amb carpetes i sense, al correu, als altres mòduls i amb un tauler, amb conversa i sense; la fila mesurada; la tira a 769 i 768 px i a 600 px; la tira al 200 % |
| N1 (`states/settings.test.ts`) | `app_sidebar_state`: minimitzada per defecte i en actualitzar, els tres estats, valors no vàlids, i només els canvis s'escriuen |
| N1 (`states/sidebar.test.ts`) | La taula de conversió de `session_sidebar_section_main`, també els valors desconeguts, buits, `day` i `person`; com es dibuixa la barra; què canvia l'estat desat (el botó, la tira, minimitzar i `i` al costat) i què no (la capa, Escapada, canviar de mòdul) |
| N2 (`components/shell/AppSidebar.test.tsx`) | La barra a cada mòdul, després de `<main>`, amb l'Agenda, i la Conversa només amb una conversa oberta (també en un tauler); què canvia l'estat desat i què no, amb el focus; l'arrencada amb `expanded` en una finestra estreta; la finestra que s'eixampla i s'estreny; per sota de 769 px, la Conversa només amb la conversa a la pantalla; el selector de panells amb el teclat, en anglès i en àrab, també amb un tercer panell afegit amb una entrada |
| N2 (`components/chat/ConversationDetailsPanel.test.tsx`) | Les proves de #212 al contenidor nou: l'agenda des de la seva pestanya i recordada, restaurada després de reiniciar, una secció desconeguda, la subsecció en canviar de conversa i l'historial d'una persona que no es recorda; l'amplada amb el teclat i restaurada |
| N2 (`components/shell/SyncStatus.test.tsx`) | El botó «Barra lateral» al final de la banda, després de l'estat de la sincronització, en l'ordre de Tab |
| e2e (`startup.e2e.ts`, «#212») | Les proves de la barra de detalls amb el botó de la banda i la regió nova, amb les mateixes expectatives (a 1100 px ja acceptaven la capa) |
| e2e (`startup.e2e.ts`, «#361») | A 600, 1024, 1100, 1180 i 1440 px, en clar i en fosc, en català i en àrab: la tira en arrencar, l'agenda sense conversa des del botó de la banda, al correu i des de Calendari, Tasques, Persones i Notes, al costat o com a capa segons la regla, al costat final de la línia (a l'esquerra en àrab), sense desplaçament horitzontal, amb axe; l'estat desat després de reiniciar, sense capa en arrencar. Al 200 % a 1440 i 1024 px: la tira i el selector de 80 px, sense desplaçament horitzontal, amb axe. L'estat i l'amplada després de reiniciar, el botó de minimitzar, l'ordre del menú, la capa que no es desa i F6 i Maj+F6 a través de la barra |
| e2e (`startup.e2e.ts`, «#306») | F6 i Maj+F6 amb la barra al costat; després del lector, la tira (minimitzada per defecte); als altres mòduls, la barra entre el mòdul i la banda |
