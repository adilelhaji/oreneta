# Barra lateral contextual (#86)

L'historial d'una persona amb un compte. Des de #363 és el panell Persona de la
barra lateral de l'aplicació, a tots els mòduls (vegeu [El panell
Persona](#el-panell-persona-363)). Abans era una vista a sobre del panell
Conversa (fins a #361, la barra lateral de detalls d'una conversa), que s'obria
amb «Historial amb …» des d'un participant; aquesta entrada es manté i ara obre
el panell Persona.

- **Què mostra:** les converses amb aquella adreça, les reunions properes en què
  és (organitzador o assistent) i els fitxers que ha enviat. Cada element obre
  el seu origen: la conversa, el dia al calendari o el missatge del fitxer.
- **Aïllament:** només un compte: al correu, el de la conversa oberta, i a
  Persones, el de la llibreta del contacte o el que es tria (des de #363). Un
  altre compte que tingui correu de la mateixa persona no hi apareix, i una
  resposta lenta per al compte anterior no es pinta al nou, ni tan sols en el
  dibuix d'abans que la pregunta nova surti.
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
  - una resposta tardana d'un altre compte no hi apareix (al panell, també al
    correu i a Persones, des de #363);
  - el dibuix que segueix un canvi de compte no conté l'historial de l'anterior
    (des de #363).

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
  clau desa el tipus de panell (vegeu més avall). Des
  de #363 es recorda el panell Persona (`person`), però mai la persona que hi havia. Fins a
  #361, si la barra estava oberta o tancada només es recordava durant la sessió;
  ara es desa (`app_sidebar_state`).
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
  | Persona | L'historial de #86 de la persona en context (des de #363; vegeu [El panell Persona](#el-panell-persona-363)) | Tots els mòduls; amb un estat buit on no n'hi ha cap |
  | Conversa | El resum (els participants), la multimèdia i els fitxers; fins a #363, també l'historial d'una persona a sobre | Correu i taulers, amb una conversa oberta |

  El Dia arriba amb la peça 12b; fins aleshores no té pestanya ni icona. Afegir
  un panell és una entrada a la llista `SIDEBAR_PANELS` de `AppSidebar.tsx`.
  L'agenda ja no és una fila del resum: és un panell.
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
  | `person` | Persona (des de #363) | Persona (des de #363) |
  | `day` | Agenda fins que hi hagi el panell; el valor es conserva | Agenda |
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
    Agenda», «Obre el panell Persona» (des de #363) i «Obre el panell Conversa», i
    no només com el panell: el Calendari ja té un botó «Agenda», el de la seva
    visualització;
  - `hidden`, amagada: no es dibuixa res.
- **Què canvia l'estat desat:** el botó «Barra lateral» de la banda superior
  quan amaga la barra, la desplega al costat o hi torna a posar la tira, i les
  icones de la tira, el botó
  de minimitzar i la tecla `i` quan la barra va al costat del contingut. Una capa
  no desa mai `expanded`, l'obri el que l'obri (una icona de la tira, el botó de
  la banda, l'ordre o `i`; decisió D5 del propietari a #360), i tancar-la
  (Escapada, un clic al fons, el botó «Tanca (Esc)», `i` o el botó de la banda)
  tampoc no canvia l'estat desat: la capa és una manera de mostrar la barra on
  no hi cap, no una preferència.
- **En arrencar no s'obre mai una capa sola:** si l'estat desat és `expanded` i
  la barra no hi cap al costat, es dibuixa la tira (per sota de 769 px, res), i
  l'estat desat no canvia. Si la finestra s'eixampla prou, torna a ser al
  costat; si s'estreny, torna a ser la tira.

### Al costat o a sobre

- **La regla** (ADR-0069 §2, `appSidebarLayout`): la barra va al costat del
  contingut si la finestra fa almenys 1100 px i

  `resta = fila − carpetes (200, si es dibuixen) − contingut (el mínim del mòdul) ≥ 280`,

  on la fila és l'amplada dibuixada sense la barra lateral. Al costat, el màxim
  és `min(560, resta)`, i el separador anuncia aquest màxim.
- **El mínim de cada mòdul** (decisió D3 del propietari a #360, que aplica la
  decisió 5 d'ADR-0069, «fins que la seva peça en fixi una altra»): el que cada
  peça ja havia fixat, a `MODULE_CONTENT_MIN` de `lib/paneResize.ts`. El
  contingut del mòdul també el demana com a base flexible (`moduleContentStyle`),
  perquè hi cedeixi primer la subfinestra de carpetes. No és un mínim estricte:
  en una fila que ni tan sols hi arriba (el zoom del sistema al 200 %), el
  contingut també cedeix, en lloc de desplaçar la finestra de costat. Al
  llindar, la persona o la nota fan uns 359,85 px, la part de la reducció que
  toca al contingut (la seva base contra els 1000 de la subfinestra de carpetes),
  i no s'hi posa un mínim estricte de 360 px: amb el zoom del sistema al 200 %
  (720 px CSS a 1440 px), els 200 px de les carpetes, la llista i 360 px de
  persona no hi caben, i els controls de la persona quedarien fora de la
  finestra (ho comprova la prova «secondary screen design»). Les
  amplades de les llistes de Persones i Notes surten de les mateixes constants
  que fan servir les vistes (`PEOPLE_LIST_PX`, `NOTES_LIST_PX`). Calendari i
  Tasques no n'havien fixat cap, i Xat (la conversa) i Adjunts (la llista), 360
  px: tots quatre conserven 360 px. Amb les carpetes al mínim:

  | Mòdul | Contingut que conserva | Resta a 1100 px | Al costat a partir de |
  |---|---|---|---|
  | Correu | La llista (280) i el lector (360): 640 px | 260 | 1120 px |
  | Calendari, Tasques, Xat, Adjunts | 360 px | 540 | 1100 px |
  | Persones | La llista (288) i la persona (360): 648 px | 252 | 1128 px |
  | Notes | La llista (320) i la nota (360): 680 px | 220 | 1160 px |
  | Un tauler | La columna del tauler: 280 px | 620 | 1100 px |
  | Un tauler amb una targeta oberta | La columna (280) i la subfinestra de conversa (360): 640 px | 260 | 1120 px |

  Per tant, a Persones i a Notes la barra passa a ser la tira (i, des de la
  tira, una capa) abans que als altres mòduls, i la persona i la nota conserven
  360 px al costat de la barra. Al correu, a 1180 px va al costat fins a 340 px,
  i a 1440 px fins a 560 px.
- **La subfinestra de conversa del tauler** compta 360 px a partir de 769 px
  (per sota, 320 px, on no hi ha tira i la barra només és una capa), i només
  amb una targeta oberta. Per això, entre 1100 i 1119 px, obrir una targeta fa
  que la barra que anava al costat del tauler passi a la tira, i tancar-la la
  torna al costat; l'estat desat no canvia.
- **Qui cedeix:** primer la subfinestra de carpetes, fins a 200 px, i després la
  llista, fins a 280 px (abans la llista no cedia davant de la barra); el lector
  conserva els seus 360 px. Als altres mòduls el contingut conserva el seu
  mínim, i per això també hi cedeix primer la subfinestra de carpetes.
- **Si no hi cap**, és una capa sobre el mòdul i la seva capçalera, de com a
  màxim el 85 % de la finestra i amb el fons del `Dialog` compartit (més fosc en
  un tema fosc), sense separador. Els diàlegs, els
  avisos i la galeria queden per sobre de la capa. La tira, quan hi és, conserva
  el seu lloc sota la capa, de manera que el mòdul no es mou. Mentre la capa
  està oberta, `<main>` és inert: el que el fons cobreix no rep el focus, i Tab i
  F6 només van entre la banda i la barra (vegeu
  [app-regions.md](app-regions.md#f6-i-majf6)).
- **La tira** sempre va al costat, a partir de 769 px, amb l'amplada que la
  regla hi compta (`SIDEBAR_STRIP_REM`, 2,5 rem). Al 200 % de l'aplicació fa 80
  px. Just per sobre de 769 px no hi cap al costat de la barra estreta de mòduls
  (`MODULE_BAR_REM`, 3 rem: 96 px) i el mínim del mòdul: no es dibuixa fins que
  hi cap, al correu a uns 816 px i a Persones a 824 px. Al 200 % a 1025 px, la
  subfinestra de carpetes, de 260 px, en cedeix 35 i en fa uns 225, i la tira de
  mòduls del seu peu hi conserva Correu, Calendari i «Més».
- **Per sota de 769 px** no hi ha tira: la barra només s'obre com a capa, des del
  botó de la banda o del menú de l'aplicació, i en tancar-se no queda res.

### Obrir, tancar i el focus

- **El botó «Barra lateral»**, al final de la banda superior, després de l'estat
  de la sincronització, a tots els mòduls, mostra i amaga tota la barra
  (decisions D4 i D7 del propietari a #360). El que se'n dibuixa desapareix: si
  està desplegada al costat o minimitzada a la tira, l'amaga i desa `hidden`; si
  és una capa, la tanca i no desa res. Si no se'n dibuixa res, la mostra: al
  costat si hi cap, i desa `expanded`; on no hi cap, hi torna a posar la tira i
  desa `minimized`, de manera que amagar la tira es desfà amb el mateix botó; i
  on tampoc no hi ha tira (per sota de 769 px), l'obre com a capa, sense desar res.
  Desplegar-la des de la tira és cosa de les icones de la tira, que obren la
  capa on no hi cap. Decideix el que es veu: amb `expanded` desat i la tira
  dibuixada perquè la barra no hi cap, el botó també l'amaga i desa `hidden`, i
  si després es torna a mostrar allà mateix queda `minimized`: amagar-la desa
  `hidden` (D4) i mostrar-la hi torna a posar la tira (D7). A la pantalla d'alta
  del primer compte no hi és.
- **El que diu el botó:** el seu nom és el de la regió, «Barra lateral», i el
  seu `aria-expanded` és cert només quan la barra està desplegada, al costat o
  com a capa (ADR-0069 §2). Amb la tira dibuixada és fals, però un clic
  l'amaga; per això el botó també diu, amb paraules, què farà un clic: la seva
  descripció (`aria-describedby`, que els lectors de pantalla diuen sigui quin
  sigui el tractament que donen al títol) i el seu títol són «Amaga la barra
  lateral» mentre se'n dibuixa alguna cosa, la tira inclosa, i «Mostra la barra
  lateral» quan no.

  | Es dibuixa | `aria-expanded` | Descripció i títol | Un clic |
  |---|---|---|---|
  | Al costat | cert | «Amaga la barra lateral» | L'amaga (`hidden`) |
  | Com a capa | cert | «Amaga la barra lateral» | Tanca la capa (no es desa) |
  | La tira | fals | «Amaga la barra lateral» | L'amaga (`hidden`) |
  | Res, i hi cap al costat | fals | «Mostra la barra lateral» | La desplega al costat (`expanded`) |
  | Res, i només hi cap la tira | fals | «Mostra la barra lateral» | Hi torna a posar la tira (`minimized`) |
  | Res, sense tira (per sota de 769 px) | fals | «Mostra la barra lateral» | L'obre com a capa (no es desa) |

- **L'ordre** «Mostra la barra lateral» o «Amaga la barra lateral», a la paleta
  i al menú de l'aplicació, a l'àrea «Aplicació», fa el mateix que el botó, i
  el seu nom és la descripció del botó en aquell moment.
- **La tecla `i`** (`thread.details`) al correu, amb una conversa oberta: si la
  barra està desplegada al panell Conversa, la minimitza (si és una capa, la tanca
  com Escapada); si no, la desplega al panell Conversa, també quan està
  amagada: al costat si hi cap (es desa `expanded`), i si no com a capa, sense
  desar res. Els botons «Detalls de la conversa» de la capçalera de la conversa
  fan el mateix que `i`. Sense cap
  conversa a la pantalla (una pestanya de lector o de redacció a sobre, o, per
  sota de 769 px, la llista al lloc del lector), `i` i aquests botons no fan res,
  ni desen res: no hi ha panell Conversa. La barra publica si n'hi ha
  (`sidebar$.conversationOpen`), com publica si hi cap al costat.
- **El focus:** la capa el pren, a la pestanya seleccionada, i en tancar-se el
  torna a l'element que l'havia obert (si ja no hi és, a la icona de la tira).
  Desplegar la barra des de la tira el porta a la pestanya del panell, i
  minimitzar-la, a la icona del panell a la tira. Un focus que ha pres una altra
  superfície (un diàleg obert des de l'agenda, el botó de la banda) s'hi queda.
  Si l'element que l'havia obert encara està dins de `<main>` inert, el focus hi
  torna tan bon punt deixa de ser-ho.
- **Escapada** va al gestor més recent de la pila compartida (`useEscapeKey`),
  la mateixa dels diàlegs, dels menús, de la galeria i de la paleta. Amb el focus
  al camp de cerca de la banda i la capa oberta, el camp és més recent: al correu
  el buida i en surt, en un tauler primer el buida i després en surt, i només
  l'Escapada següent tanca la capa. Un menú obert des del camp encara és més
  recent i la pren abans.
- **La capa es tanca** també quan el que s'obre és sota seu, al mòdul inert: en
  canviar de mòdul (un esdeveniment de l'agenda obre el calendari), amb «Mostra a
  la conversa» d'una imatge o d'un fitxer, abans d'obrir una imatge a la galeria
  del lector, amb «Mostra els missatges amb …» d'un participant, amb «Missatge
  nou per a …» d'un participant (la redacció s'obre al lector) i amb una
  conversa de l'historial d'una persona. Es tanca també amb les ordres que
  porten al davant alguna cosa del mòdul o hi posen el focus, que sota la capa
  no farien res que es veiés: `r` i «Respon», que posen el focus a la
  resposta ràpida; la cerca de la conversa; qualsevol pestanya del lector que
  passa al davant (un missatge nou amb Ctrl/⌘+N, una resposta a l'editor
  complet, un missatge a la seva pestanya o tornar a la conversa); i, des de la
  paleta o des del menú de l'aplicació, anar a un altre mòdul, carpeta, compte,
  tauler o filtre. Ho fan les dades mateixes (`states/sidebar.ts`,
  `states/compose.ts`) i, a les ordres, el seu embolcall `inModule` de
  `useCommandList`, triat ordre per ordre. Les altres ordres actuen fora de
  `<main>` (la configuració i les seves seccions, els temes, les pauses de les
  notificacions, «Quant a», les dreceres, el catàleg de disseny, la paleta, el
  camp de cerca de la banda, els diàlegs de correspondència i de respostes
  pendents) o sobre les dades sense portar res al davant (sincronitzar, marcar
  com a llegit, arxivar), com les seves dreceres, i deixen la capa com està;
  la de la barra ja decideix sobre la capa. Per exemple, la configuració oberta
  des de la paleta s'obre per sobre de la capa, que s'hi queda, i en tancar-se
  torna el focus a la pestanya de la capa.
- **Subfinestres de la dreta de cada mòdul:** el detall d'un esdeveniment del
  calendari és un diàleg modal, i la subfinestra de conversa del tauler és dins
  de la fila del tauler; cap no topa amb la barra.

### Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`lib/paneResize.test.ts`) | La regla a 1100, 1119, 1120, 1180 i 1440 px, amb carpetes i sense, al correu, a Calendari, Tasques, Xat i Adjunts (540 px a 1100 px), a Persones (al costat a partir de 1128 px) i a Notes (a partir de 1160 px), i amb un tauler, amb una targeta oberta i sense, també el pas a la tira entre 1100 i 1119 px en obrir-ne una; el mínim que demana el contingut de cada mòdul com a base (`moduleContentStyle`); la fila mesurada; la tira a 769 i 768 px i a 600 px; la tira al 200 %, al correu i a Persones |
| N1 (`states/settings.test.ts`) | `app_sidebar_state`: minimitzada per defecte i en actualitzar, els tres estats, valors no vàlids, i només els canvis s'escriuen |
| N1 (`states/sidebar.test.ts`) | La taula de conversió de `session_sidebar_section_main`, també els valors desconeguts, buits, `day` i `person`; com es dibuixa la barra; el botó en cada estat i espai (la taula de més amunt: què es dibuixa, l'`aria-expanded`, l'acció, què fa un clic i què desa), també amagar la tira i tornar-la a posar on no hi cap al costat; la tira, minimitzar i `i` al costat, i `i` amb la barra amagada on no hi cap, que obre la capa sense desar res; què no canvia l'estat desat (la capa, l'obri el que l'obri, Escapada, canviar de mòdul); `i` sense conversa a la pantalla no fa res ni desa res; la resposta ràpida, la cerca de la conversa i una pestanya que passa al davant tanquen la capa |
| N2 (`components/shell/AppSidebar.test.tsx`) | La barra a cada mòdul, després de `<main>`, amb l'Agenda i (des de #363) la Persona, i la Conversa només amb una conversa oberta (també en un tauler); què canvia l'estat desat i què no, amb el focus; l'arrencada amb `expanded` en una finestra estreta; la finestra que s'eixampla i s'estreny; per sota de 769 px, la Conversa només amb la conversa a la pantalla; el selector de panells amb el teclat, en anglès i en àrab, també amb un panell més afegit amb una entrada; el botó de la banda (amaga, desplega, l'`aria-expanded`, la descripció per `aria-describedby` i el títol), i a 1024 px la tira que amaga i torna a posar, desada, amb el focus al botó; per sota de 769 px, la capa que obre des de res i el focus que hi torna; `i` sota una pestanya de redacció i per sota de 769 px amb la llista; la capa que es tanca amb «Missatge nou per a …», «Mostra els missatges amb …», una imatge de la galeria, una conversa de l'historial d'una persona i Ctrl/⌘+N; `<main>` inert sota la capa i el focus que hi torna en tancar-la; Escapada al camp de cerca de la banda abans que a la capa; la tira de 2,5 rem |
| N2 (`components/palette/useCommandList.test.tsx`) | Les ordres que porten al davant el mòdul (un missatge nou, un filtre, una carpeta, un compte, un tauler, un mòdul) tanquen la capa abans d'actuar; les que actuen fora del mòdul o sobre les dades (la configuració, un tema, una pausa, «Quant a», la paleta, les dreceres, el catàleg, afegir un compte, la cerca de la banda, sincronitzar, marcar com a llegit) la deixen oberta; la de la barra la tanca sense amagar la tira |
| N2 (`components/chat/SidebarAgenda.test.tsx`) | Un esdeveniment de l'agenda tanca la capa abans d'obrir-se al Calendari, també des del Calendari mateix |
| N2 (`components/chat/ConversationDetailsPanel.test.tsx`) | Les proves de #212 al contenidor nou: l'agenda des de la seva pestanya i recordada, restaurada després de reiniciar, una secció desconeguda, la subsecció en canviar de conversa i, des de #363, «Historial amb …», que obre el panell Persona, recordat com a `person` i mai amb la persona, que no passa a una altra conversa; l'amplada amb el teclat i restaurada |
| N2 (`components/shell/SyncStatus.test.tsx`) | El botó «Barra lateral» al final de la banda, després de l'estat de la sincronització, en l'ordre de Tab |
| e2e (`startup.e2e.ts`, «#212») | Les proves de la barra de detalls amb el botó de la banda i la regió nova, amb les mateixes expectatives (a 1100 px ja acceptaven la capa) |
| e2e (`startup.e2e.ts`, «#361») | A 600, 1024, 1100, 1180 i 1440 px, en clar i en fosc, en català i en àrab: la tira en arrencar, l'agenda sense conversa des del botó de la banda, al correu i des de Calendari, Tasques, Persones i Notes, al costat o com a capa segons la regla, al costat final de la línia (a l'esquerra en àrab), sense desplaçament horitzontal, amb axe; l'estat desat després de reiniciar, sense capa en arrencar. Al 200 % a 1440 i 1024 px: la tira i el selector de 80 px, sense desplaçament horitzontal, amb axe. L'estat i l'amplada després de reiniciar, el botó de minimitzar, el botó de la banda que amaga la tira i la desplega des de res, amb la descripció i el títol, l'ordre del menú, la capa que no es desa (des d'una icona de la tira), a 1100 px el botó que torna a posar la tira amagada, desada com a `minimized`, i F6 i Maj+F6 a través de la barra. A 1024 px, el botó i l'ordre del menú que amaguen la tira i la tornen a posar, desada després de reiniciar, sense capa i amb `<main>` actiu; la capa, només des de la icona. A Persones a 1127, 1128, 1180 i 1440 px i a Notes a 1159, 1160, 1180 i 1440 px, amb `expanded` desat: la barra al costat o la tira segons el mínim del mòdul, i la persona i la nota, mesurades, d'almenys 360 px, abans de la barra. Al 200 % a 1025 px, la tira per defecte: 80 px, la subfinestra de carpetes de 225 px amb Correu, Calendari i «Més», sense desplaçament horitzontal. A 1024 px, la capa de `i`: `<main>` inert, F6 i Maj+F6 només entre la banda i la barra, Tab que no hi entra, el focus que torna a la fila, Escapada al camp de cerca de la banda abans que a la capa, i `r`, que la tanca i posa el focus a la resposta ràpida. La configuració oberta des de la paleta per sobre de la capa, que s'hi queda, i el focus que torna a la pestanya de la capa i, en tancar-la, a la icona de la tira |
| e2e (`startup.e2e.ts`, «#306») | F6 i Maj+F6 amb la barra al costat; després del lector, la tira (minimitzada per defecte); als altres mòduls, la barra entre el mòdul i la banda |

## El panell Persona (#363)

Peça 12c del redisseny, segons
[ADR-0069](../adr/0069-barra-lateral-de-tota-l-aplicacio.md) (§1, §2 i §4).
Codi: `frontend/src/components/chat/PersonPanel.tsx` (el panell, que fa servir
el `PersonHistory` de #86, sense copiar-lo), `states/person.ts` (qui és la persona en context, i
`resolvePersonPanel`, la regla del §4) i l'entrada `person` de `SIDEBAR_PANELS`
a `AppSidebar.tsx`.

- **On és:** a tots els mòduls, amb la pestanya «Persona» després de l'Agenda
  (i del Dia, quan hi sigui) i abans de la Conversa, i la icona «Obre el panell
  Persona» a la tira. On no hi ha ningú, un estat buit diu què s'ha de
  seleccionar.
- **Qui és la persona:**
  - al correu, amb una conversa oberta (també en un tauler amb la subfinestra
    de conversa), la persona que hi participa i no és cap dels comptes propis
    (ni cap dels seus àlies), si n'hi ha una de sola; si n'hi ha diverses, la
    llista d'aquestes persones, per triar-ne una, i el botó «Tria una altra
    persona» hi torna. Si a la conversa no hi ha ningú més que els comptes
    propis, el panell ho diu. Les persones surten dels missatges de la conversa,
    mai dels de l'anterior: mentre els missatges encara són els de l'anterior i
    es llegeixen els nous, el panell espera; si la lectura acaba sense cap
    missatge de la conversa (ha fallat, o tots esperen el cos, cosa que sense
    connexió pot no arribar mai), surten de la fila de la llista, que és
    d'aquesta conversa;
  - a Persones, el contacte seleccionat a la llista;
  - als altres mòduls, o sense conversa ni contacte, ningú: «Obre una conversa
    per veure l'historial…», «Selecciona un contacte…» o «Obre una conversa al
    Correu o un contacte a Persones…». No s'endevina ningú.
- **Com ho sap la barra:** el panell llegeix el mòdul que hi ha a la pantalla i
  `person$` (`states/person.ts`), que no es desa mai:
  - al correu, la persona triada (a la llista del panell o amb «Historial amb …»)
    es guarda amb la conversa i el compte on s'ha triat: en una altra conversa,
    o en el mateix fil d'un altre compte, no compta;
  - a Persones, la persona és la selecció de la llista (`people$.selectedId`),
    sense còpia, i `person$` només guarda el que el panell ha demanat per a
    aquell contacte: l'adreça, si en té més d'una, i el compte, si la llibreta
    no en té. Seleccionar un altre contacte comença sense res triat.
- **El compte (aïllament de #86):** al correu, el de la conversa. A Persones, el
  de la llibreta del contacte (`contact_sources.account`, que arriba amb cada
  persona de `people.list`). Si la llibreta no és de cap compte (la d'aquest
  ordinador, o una de CardDAV sense compte), o si el compte ja no hi és, el
  panell ho diu i demana el compte en un desplegable («Tria un compte», amb els
  comptes de correu i sense els canals), sense triar-ne cap tot sol, ni tan sols
  quan només n'hi ha un. No barreja mai comptes.
- **L'adreça:** l'historial és d'una adreça sencera (#86). Un contacte amb més
  d'una adreça la demana en un altre desplegable («Tria una adreça»), i un
  contacte sense cap adreça ho diu.
- **El contingut i les regles** són els de #86 (vegeu més amunt). A sobre, la
  capçalera diu amb qui («Amb …»), l'adreça i el compte («Compte: …»).
- **Obrir:** una conversa de l'historial s'obre al correu, al compte de
  l'historial (des de Persones, el correu passa al davant), i la persona hi
  continua en context. Per sota de 769 px es mostra la conversa en lloc de la
  llista, com quan s'obre des de Tasques o des d'Adjunts; un esdeveniment obre el seu dia al Calendari
  (`openCalendarOn`). Abans d'obrir-ho, la capa es tanca, com a l'agenda.
- **«Historial amb …»**, al menú d'un participant del panell Conversa, obre el
  panell Persona amb aquella persona, sense canviar com es dibuixa la barra ni
  desar res més que el panell, i porta el focus a la pestanya Persona.
- **El focus:** triar una persona de la llista el porta al títol del seu
  historial, i «Tria una altra persona», a la persona que s'hi veia.
- **Panell recordat:** `session_sidebar_section_main` desa `person`, mai la
  persona ni l'adreça. Després de reiniciar, el panell torna amb la persona que
  hi ha en context en aquell moment, o amb l'estat buit.
- **Cadenes noves:** `sidebar.person` i 14 claus `person.*` (els estats buits,
  la llista, les tries de l'adreça i del compte i la línia del compte), en els
  20 catàlegs.

### Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`states/person.test.ts`) | La regla del §4: al correu, una persona, diverses (la llista, sense triar-ne cap), la triada en aquesta conversa i aquest compte (i no la d'una altra conversa, d'un altre compte o de fora de la conversa), ningú més i la conversa que encara es llegeix; a Persones, el compte de la llibreta, la llibreta que no és de ningú (demana el compte, també amb un sol compte i sense els canals, i un compte que ja no hi és), la tria per contacte, diverses adreces i cap; l'estat buit als altres mòduls; el que es guarda per contacte; «Historial amb …» desa el panell i no la persona |
| N2 (`components/chat/PersonPanel.test.tsx`) | Al correu: una persona, al compte de la conversa; diverses, amb la llista, el focus al títol i de tornada a la persona; ningú més; «Historial amb …» des del panell Conversa, amb el focus a la pestanya; una resposta tardana per al compte anterior que no hi apareix; obrir una conversa (la persona hi continua) i un esdeveniment. A Persones: el contacte seleccionat a la llista, al compte de la seva llibreta, i la conversa que s'obre al correu en aquell compte; la llibreta que no és de ningú, que demana el compte, i la resposta tardana del compte deixat; diverses adreces i cap. A tots els mòduls, l'estat buit |
| N2 (`components/chat/PersonPanel.test.tsx`, revisió) | Una conversa en què s'ha respost des d'un àlies té una sola persona més; la fila de la llista quan la lectura acaba sense cap missatge de la conversa, i l'espera mentre es llegeix; cap consulta de les persones de la conversa anterior al compte de la següent; la resposta tardana per al contacte deixat, amb una altra adreça; a 600 px, una conversa de l'historial obre la conversa i no la llista |
| N2 (`components/chat/conversationMedia.test.ts`) | Els àlies dels comptes propis compten com a propis (també per a l'etiqueta «Tu» del resum) |
| N2 (`components/chat/PersonHistory.test.tsx`) | Les proves de #86, i el dibuix que segueix un canvi de compte, sense l'historial de l'anterior |
| N2 (`components/chat/ConversationDetailsPanel.test.tsx`, `states/sidebar.test.ts`, `components/shell/AppSidebar.test.tsx`) | La taula de conversió amb `person`; «Historial amb …», que obre el panell i no passa a una altra conversa; la pestanya i la icona Persona a cada mòdul, i el selector de panells amb el teclat, en anglès i en àrab |
| e2e (`startup.e2e.ts`, «#363») | A 1440 px, en català i en àrab: la icona de la tira; l'estat buit al correu sense conversa; la conversa amb Morgan, al seu compte; «Historial amb …» des del panell Conversa, amb el focus a la pestanya; a Persones, el contacte d'una llibreta de compte, i el d'una llibreta que no és de ningú, que demana el compte i no consulta res fins que es tria; al final de la línia (a l'esquerra en àrab), sense desplaçament horitzontal i amb axe; el panell recordat com a `person`, sense cap adreça a les preferències, després de reiniciar |
