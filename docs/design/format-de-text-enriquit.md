# Format de text enriquit i taules al redactor

Incidència #274 (fila SET-10, pare #88). La decisió és a l'ADR-0067.

## Què ofereix la barra d'eines

En mode enriquit, després de negreta, cursiva, subratllat i ratllat:

- «Tipus de lletra»: Arial, Courier New, Georgia, Tahoma, Times New Roman,
  Trebuchet MS i Verdana, cada un amb tipus de reserva (`FONT_FAMILIES`).
  «Per defecte» treu el tipus de lletra.
- «Mida de la lletra»: de 8 a 36 punts (`FONT_SIZES`). «Per defecte» la treu.
- «Color del text» i «Color de ressaltat»: set colors cada un (gris, vermell,
  taronja, groc, verd, blau i lila) i «Treu el color».
- «Alinea a l'esquerra», «Centra», «Alinea a la dreta» i «Justifica».
- «Redueix el sagnat» i «Augmenta el sagnat»: dins d'una llista, l'element de
  la llista; fora, el paràgraf, de 0 a 8 nivells de 40 px.
- «Insereix una taula» (3 × 3, amb una fila de capçalera). Dins d'una taula
  apareixen «Insereix una fila a sobre», «Insereix una fila a sota»,
  «Insereix una columna abans», «Insereix una columna després», «Suprimeix la
  fila», «Suprimeix la columna» i «Suprimeix la taula».

Un tipus de lletra o una mida que arriben amb text enganxat o citat i no són a
la llista es mostren com a opció pròpia.

## Dreceres

Mod és ⌘ al macOS i Ctrl a la resta.

| Drecera | Ordre |
|---|---|
| Mod+Maj+L, E, R, J | Alinea a l'esquerra, centra, alinea a la dreta, justifica |
| Mod+] i Mod+[ | Augmenta i redueix el sagnat |
| Tab i Maj+Tab en una taula | Cel·la següent i anterior; Tab a l'última cel·la afegeix una fila |

- Mod+Maj+R és «Sincronitza la bústia» fora de l'editor. Dins de l'editor
  alinea a la dreta i la bústia no se sincronitza (`FormattingShortcuts`, a
  `frontend/src/components/composer/richText.ts`).
- En els teclats on `[` i `]` s'escriuen amb AltGr (català, castellà, francès,
  alemany), Mod+AltGr+] i Mod+AltGr+[ també funcionen.
- L'editor es queda aquestes combinacions encara que una drecera de
  l'aplicació s'hi hagi assignat a la configuració.
- Els editors de signatures i de notes no les tenen: allà Mod+Maj+R continua
  sincronitzant.

## Què s'envia

- L'esquema de l'editor és l'únic filtre de l'HTML que s'envia. El color, el
  color de fons, el tipus de lletra i la mida es validen en llegir-los i en
  escriure'ls (`safeCssColor`, `safeFontSize`, `safeFontFamily`). Un valor que
  no passa es descarta, i el text es queda sense aquell estil. Les cel·les
  ocupen com a màxim 50 columnes o files (`clampSpan`).
- `inlineRichStyles` (`composerHelpers.ts`):
  - dona a les taules fetes al redactor (classe `oreneta-table`) la mateixa
    graella que es veu a l'editor, amb els paràgrafs de les cel·les sense
    marge;
  - posa un color fosc al text amb color de fons que no en té de propi;
  - converteix el sagnat en `margin-left`, o `margin-right` en un paràgraf de
    dreta a esquerra, i treu `data-indent`.
- L'alternativa de text pla (`htmlToText`, `lib/html.ts`) escriu cada fila
  d'una taula de dades en una línia, amb les cel·les separades per ` | `. Una
  taula de maquetació (amb taules a dins o cel·les de més d'un bloc o amb salts de línia, com les
  dels butlletins i les signatures citats) es llegeix com els paràgrafs que
  conté. Els colors, els tipus de lletra, les mides, l'alineació i el sagnat
  no hi passen.

## Proves

- `richText.test.ts`: els validadors, cada ordre, el límit de les cel·les, la
  graella a l'editor, les dreceres (també que Mod+Maj+R no arribi a la
  finestra des de l'editor i que hi arribi des d'un altre camp, i AltGr per als
  claudàtors), Tab a les taules i l'HTML i el text pla que s'envien.
- `ComposerToolbar.test.tsx`: cada control de la barra amb l'editor.
- `composerHelpers.test.ts` i `lib/html.test.ts`: els estils en línia i el text
  pla de les taules de dades i de maquetació.

## Pendent

- Com es veu el missatge en clients reals (Outlook, Gmail, Apple Mail):
  evidència N4/N5, sense fer.
- La mida del fitxer JavaScript de l'aplicació abans i després: no s'ha
  mesurat.
- Al redactor, el sagnat d'un paràgraf de dreta a esquerra es veu a l'esquerra
  quan la interfície és d'esquerra a dreta; el missatge enviat el porta a la
  dreta.
- Una taula enganxada des d'un full de càlcul arriba sense graella, i no hi ha
  cap ordre per posar-n'hi.
