# Zoom amb el teclat (#181)

Wails deixa el WebView sense les dreceres de zoom del navegador: Ctrl/⌘ amb `+`,
`-` i `0` no fan res. El propietari va decidir (2026-10-12) fer servir l'escala
pròpia de l'aplicació, no un `zoom` de CSS a l'arrel.

## Com funciona

- **Dreceres:**
  - Ctrl/⌘ `=` amplia. Ctrl/⌘ `+` també amplia, s'escrigui com s'escrigui
    (Maj+`=` o la tecla `+` del teclat numèric).
  - Ctrl/⌘ `-` redueix i Ctrl/⌘ `0` torna al 100 %.
  - Són a *Dreceres de teclat → Visualització* i es poden reassignar. Si es
    reassigna «amplia», el `+` també deixa d'ampliar.
  - Funcionen encara que s'estigui escrivint, com en un navegador: cap no edita
    text i els editors no en fan servir cap.
  - També arriben des del marc aïllat d'un missatge HTML, que reenvia les
    dreceres amb Ctrl/⌘.
- **Escala:**
  - mou el paràmetre *Aparença → Mida del text* (`font_scale`), que canvia la
    mida de lletra de l'arrel;
  - amb aquest paràmetre creixen tots els textos i espais mesurats en rem;
  - els passos són els d'un navegador: 80, 90, 100, 110, 125, 150, 175 i
    200 %;
  - el màxim puja de 150 a 200 %, cosa que exigeix el WCAG 1.4.4;
  - un avís indica la mida nova;
  - es desa i es recupera després de reiniciar.
- **Per què no el `zoom` de CSS:** amb `zoom` a l'arrel, les media queries
  continuen mesurant la finestra en píxels sense zoom, i el disseny responsiu
  deixa de correspondre al que es veu. Amb l'escala pròpia, les media queries
  continuen llegint l'amplada real.
- **El que no s'escala sol**, i s'ha canviat perquè ho faci:
  - la barra lateral mesurava 60 px fixos amb botons en rem, i al 200 % els
    botons sortien per l'esquerra; va passar a mesurar `w-15` (3,75 rem). Des de
    #354 aquesta barra vertical no hi és: la tira de mòduls, al peu de la
    subfinestra de carpetes, fa 2,5 rem d'alçada, amb llocs de 2 rem, i la barra
    estreta de 769 a 1024 px, 3 rem d'amplada; el que no hi cap va a «Més» (al 200 %,
    en una subfinestra de 260 px, dos mòduls i «Més»);
  - a la capçalera de la conversa, els botons deixen espai segons l'amplada de
    la mateixa capçalera, mesurada en rem amb container queries; abans
    depenien de l'amplada de la finestra en px. Per sota de 42 rem s'amaga
    l'assistent; per sota de 30 rem, el correu brossa; per sota de 24 rem,
    destacar i no llegit; per sota de 20 rem, etiquetar i la paperera; i, per
    sota de 16 rem, la cerca a la conversa i els detalls (#347). «Arxiva la
    conversa» i «Més accions» no s'amaguen mai (ADR-0068 §3): fins a #347,
    arxivar s'amagava amb la paperera, i al 200 % a 1025 px, on el lector fa
    360 px (11,25 rem), «Més accions» quedava sota la tira de la barra lateral.
    Ara la capçalera hi té l'assumpte, «Arxiva la conversa» i «Més accions».
    Al 100 % es veuen com abans en totes les amplades que prova `mail
    boundary`, on la capçalera fa 22,5 rem o més;
  - el menú «Més accions» té sempre destacar, arxivar, el correu brossa i la
    paperera i, mentre els seus botons estan amagats, la cerca a la conversa,
    «Etiqueta» (un submenú amb les etiquetes, de 14 rem, que s'obre al costat
    i no tanca el menú en posar o treure una etiqueta) i els detalls, amb
    l'estat del panell marcat (#347). No llegit i l'assistent no hi són. El
    menú no és mai més ample que la capçalera: al 200 %, els 13 rem d'abans
    no cabien en un lector de 360 px, que en retallava una part;
  - a la resposta ràpida, quan el quadre fa menys de 16 rem, el text i el
    botó d'enviar passen a una fila pròpia, sota els botons d'adjuntar i de
    l'editor complet, i l'ordre de lectura no canvia. Abans el text es quedava
    amb l'amplada que li deixaven els botons: al 200 % a 1025 px, una columna
    de 18 px, d'una lletra (#347);
  - a l'editor de missatges, els camps, la barra de format, el cos i els
    adjunts es desplacen junts quan no hi caben d'alçada, i el peu (Descarta i
    Envia), l'error de l'enviament i l'estat de la còpia local es queden a la
    vista; el cos no es fa més baix de 8 rem. Al 200 % a 1025 px, els camps i
    la barra de format ocupen diverses files i empenyien el peu fora de
    l'editor (#347). On tot hi cap, només es desplaça el cos, com abans;
  - al camp de destinataris faltava `min-w-0`, i l'amplada natural del camp
    empenyia «Cc/Cco» fora de la pantalla.
- **La banda superior** (#343, ADR-0068 §2, [top-band.md](top-band.md)) es
  mesura en rem des del principi: 2,25 rem (`h-9`), és a dir, 36 px al 100 % i
  72 px al 200 %. El seu menú fa 20 rem d'amplada, sense passar mai de l'amplada
  de la finestra. L'alçada de la banda surt de les subfinestres que té a sota:
  al 200 % i a 1025 px la pàgina no es desplaça, i els controls dels límits del
  correu continuen dins de l'alçada de la finestra. Des de #344 la banda té el
  camp de cerca, també en rem: 1,75 rem d'alçada i, com a màxim, 36 rem
  d'amplada. Al 200 % a 1025 px, com al 100 % entre 769 i 1024 px, s'encongeix
  entre el botó del menú i el final de la banda, sense desplaçament horitzontal.
  Des de #345, el final de la banda té l'indicador del mode No molestis i
  l'estat de la sincronització; ocupa com a màxim el 35 % de l'amplada de la
  banda, una proporció i no una mida en rem, perquè al 200 % el camp de cerca hi
  conservi l'espai: el resum de l'estat s'hi escurça amb «…» i es llegeix sencer
  al nom accessible i a la indicació. Per sota de 1025 px l'estat és només la
  icona. La seva finestra emergent fa 24 rem d'amplada, mai més ampla que la
  finestra menys 8 px a cada costat, i es desplaça si no hi cap d'alçada.
  Des de #361, al final de la banda hi ha també el botó «Barra lateral», de
  2 rem. La barra lateral de l'aplicació té l'amplada en px
  (`details_panel_width`, 280–560 px), que no creix amb el zoom, i la tira
  minimitzada i el selector de panells, en rem: 2,5 rem, 80 px al 200 %. Just per
  sobre de 769 px, al 200 %, al correu no hi cap la tira al costat de la barra
  estreta, la llista i el lector, i no es dibuixa fins que hi cap (vegeu
  [contextual-sidebar.md](contextual-sidebar.md#la-barra-lateral-de-laplicació-361)).
  A 1025 px, al 200 %, la tira, que hi és per defecte, fa que la subfinestra de
  carpetes, de 260 px, en cedeixi 35 i en faci uns 225: la tira de mòduls del seu
  peu hi conserva Correu, Calendari i «Més», sense desplaçament horitzontal.
- **El que continua en px:**
  - l'amplada dels taulers que la persona arrossega;
  - l'amplada de la subfinestra de carpetes (260 px per defecte, de 200 a 400,
    #317, ADR-0068 §7): al 200 % hi creix el text, no la subfinestra, i un nom
    que no hi cap acaba en «…» amb el nom sencer a la indicació. Al Calendari
    (#323), a partir de 1025 px els calendaris són a la subfinestra, i no a la
    columna de 12 rem d'abans, i els dies del calendari petit s'encongeixen fins
    a cabre-hi. A Persones (#326), a partir de 1025 px els grups són a la
    subfinestra, i la columna de la llista és de 288 px, no de 18 rem, perquè al
    200 % la persona no es quedi sense lloc. A Tasques (#329), a partir de 1025
    px les llistes són a la subfinestra, i les tasques ocupen tot l'espai que la
    subfinestra deixa (fins a #354, també la barra vertical). A Notes (#335), a partir de 1025 px
    les etiquetes són a la subfinestra, i la columna de la llista és de 320 px,
    no de 20 rem, perquè al 200 % la nota no es quedi sense lloc. A Xat (#337),
    a partir de 1025 px les converses són a la subfinestra, i la conversa
    oberta demana 360 px com a base (el mínim del lector) en lloc de la
    columna de 18 rem, que desapareix. A Adjunts (#339), a partir de 1025 px
    els filtres són a la subfinestra, un per fila, i la llista demana 360 px
    com a base: la subfinestra cedeix abans;
  - el llindar de la cerca a la conversa (900 px), que va coordinat amb la
    barra mòbil i amb un `matchMedia`. Per això, al 200 % a 1025 px, la cerca
    oberta a la capçalera, de 286 px, no hi cap (#347).
- **Límit conegut (#347):** al 200 % a 1025 px, la conversa s'obre al primer
  missatge no llegit, i en un lector de 360 px la capçalera del missatge, que
  ajusta el nom i l'adreça en diverses línies, i les seves accions ocupen tota
  la part visible: el text del missatge, i el de la resposta que el segueix,
  queden a sota i s'hi arriba desplaçant la conversa. Cap no queda tallat. Que
  es vegi el text sense desplaçar-se demana un lector més ample o un missatge
  més compacte, i és una decisió del propietari.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`fonts.test.ts`) | Passos de 100 a 200 % i tornada; una mida escrita a mà va al pas més proper en aquella direcció; màxim 200 % |
| N1 (`shortcuts.test.ts`) | Ctrl/⌘ amb `=`, `+` (amb Maj o sense), `-` i `0`; mai sense la tecla d'ordre; reassignar «amplia» treu també el `+`; sense col·lisions amb les dreceres per defecte |
| N2 (`zoom.test.ts`) | El paràmetre es mou, l'arrel passa a 32 px al 200 % i torna; l'avís indica la mida |
| e2e (`startup.e2e.ts`, 1440 i 1024 px) | Al 200 % no hi ha desplaçament horitzontal i cap botó no queda fora de la pantalla a la bústia, al lector i a la redacció; Ctrl/⌘ `-` amb el focus en un camp no toca el text ni el focus; la mida es recupera després de recarregar; Ctrl/⌘ `0` la restableix |
| e2e (`startup.e2e.ts`, «#343», 1025 px) | Al 200 % la banda superior fa 72 px, la pàgina no es desplaça i la llista, les carpetes, la resposta i els botons de la bústia i de la conversa continuen dins de l'alçada de la finestra |
| e2e (`startup.e2e.ts`, «mail boundary … 200 %», «#347», 1025 px) | Al 200 %, en clar i en fosc, la comprovació de límits del correu (`verifyMailBoundary`): la llista, «Arxiva la conversa», «Més accions» i la resposta ràpida, de 160 px d'amplada o més, a la vista sense desplaçar res; el text de la resposta, desplaçant la conversa; a l'editor, Envia i Descarta a la vista en obrir-lo i el cos quan rep el focus; sense desplaçament de la pàgina en cap direcció |
| e2e (`startup.e2e.ts`, «#347», 1025 px) | Al 200 %, en anglès i en àrab: el lector fa 360 px; «Arxiva la conversa» i «Més accions», en aquest ordre, al final de la línia i dins del lector; la cerca, etiquetar, la paperera i el botó dels detalls no hi són. «Més accions», obert amb el teclat, queda dins del lector, i Fi i Amunt arriben als detalls i a «Etiqueta»; «Etiqueta» obre les etiquetes al costat de la fila (14 rem), i n'hi treu una sense tancar el menú; Escapada torna el focus a la fila i, després, al botó; Envia i Descarta queden dins del lector; res no surt de la finestra, i axe no troba res crític ni greu, amb els menús oberts i sense |
| N2 (`ConversationHeader.test.tsx`, #347) | Cap regla no amaga «Arxiva la conversa» ni «Més accions»; al menú, la cerca obre la de la conversa, els detalls diuen si el panell Conversa és obert i el commuten com el botó, «Etiqueta» posa etiquetes sense tancar el menú (prémer el submenú no és prémer fora) i «Gestiona les etiquetes» obre la configuració; un canal no té «Etiqueta», i amb la cerca oberta el menú no té la cerca |
| e2e (`startup.e2e.ts`, «#344», 1025 px i de 769 a 1024 px) | Al 200 % a 1025 px, i al 100 % a 1024, 900 i 769 px, el camp de cerca de la banda i els seus botons queden dins de la finestra, després del botó del menú, sense desplaçament horitzontal |
| e2e (`startup.e2e.ts`, «#361», 1440 i 1024 px) | Al 200 %, en català i en àrab: la tira de la barra lateral fa 80 px; desplegada al correu i al Calendari, l'agenda i el selector de panells (80 px) són dins de la finestra, sense desplaçament horitzontal, amb axe |
| e2e (`startup.e2e.ts`, «#361», 1025 px) | Al 200 %, amb la tira per defecte: la tira fa 80 px al final de la fila, la subfinestra de carpetes en fa 225, amb Correu, Calendari i «Més» a la tira de mòduls (80 px d'alçada) i tots els botons dins, i la icona de l'Agenda dins de la finestra, sense desplaçament horitzontal |
| e2e (`startup.e2e.ts`, «#345», 1025 px i de 769 a 1024 px) | Al 200 % a 1025, 1024, 900 i 769 px, amb el mode No molestis activat: el final de la banda no passa del 35 % de la banda; el botó del menú, el camp de cerca (de més de 100 px), l'indicador del mode No molestis i el botó de l'estat són dins de la finestra, en aquest ordre; la finestra emergent hi queda a 1025 i 769 px; sense desplaçament horitzontal |

Falta la prova nativa (N4) a Windows, que es farà una sola vegada amb la versió
final.
