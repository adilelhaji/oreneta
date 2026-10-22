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
    botons sortien per l'esquerra; ara mesura `w-15` (3,75 rem);
  - a la capçalera de la conversa, els botons que deixen espai quan el tauler
    és estret (destacar, no llegit, assistent i, després, arxivar i paperera)
    s'amaguen segons l'amplada de la mateixa capçalera (per sota de 24 rem i
    de 20 rem; al 100 % es veuen com abans en totes les amplades que prova
    `mail boundary`), mesurada en rem amb container queries. Abans depenien de
    l'amplada de la finestra en px. Tots continuen al menú ⋮;
  - al camp de destinataris faltava `min-w-0`, i l'amplada natural del camp
    empenyia «Cc/Cco» fora de la pantalla.
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
    barra vertical i la subfinestra deixen. A Notes (#335), a partir de 1025 px
    les etiquetes són a la subfinestra, i la columna de la llista és de 320 px,
    no de 20 rem, perquè al 200 % la nota no es quedi sense lloc. A Xat (#337),
    a partir de 1025 px les converses són a la subfinestra, i la conversa
    oberta demana 360 px com a base (el mínim del lector) en lloc de la
    columna de 18 rem, que desapareix;
  - el llindar de la cerca a la conversa (900 px), que va coordinat amb la
    barra mòbil i amb un `matchMedia`.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`fonts.test.ts`) | Passos de 100 a 200 % i tornada; una mida escrita a mà va al pas més proper en aquella direcció; màxim 200 % |
| N1 (`shortcuts.test.ts`) | Ctrl/⌘ amb `=`, `+` (amb Maj o sense), `-` i `0`; mai sense la tecla d'ordre; reassignar «amplia» treu també el `+`; sense col·lisions amb les dreceres per defecte |
| N2 (`zoom.test.ts`) | El paràmetre es mou, l'arrel passa a 32 px al 200 % i torna; l'avís indica la mida |
| e2e (`startup.e2e.ts`, 1440 i 1024 px) | Al 200 % no hi ha desplaçament horitzontal i cap botó no queda fora de la pantalla a la bústia, al lector i a la redacció; Ctrl/⌘ `-` amb el focus en un camp no toca el text ni el focus; la mida es recupera després de recarregar; Ctrl/⌘ `0` la restableix |

Falta la prova nativa (N4) a Windows, que es farà una sola vegada amb la versió
final.
