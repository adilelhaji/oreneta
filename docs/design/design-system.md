# Sistema de disseny: superfícies, vores, focus i radis (#287)

Primera peça del redisseny que el propietari va aprovar el 2026-10-17 («Lo apruebo»),
amb les decisions D2 (dos tons de superfície a tots els temes, sempre que cada tema
compleixi el contrast AA) i D3 (cantonades gairebé rectes). Aquesta peça només canvia
tokens i les primitives que els fan servir; la disposició de l'aplicació (panell de
carpetes, selector de mòduls, banda superior, barra lateral) arriba en peces
posteriors, algunes amb ADR pròpia.

Oreneta conserva la seva identitat: l'accent cobalt, les icones de Lucide, la
tipografia Inter, els textos propis (primer en català) i els 16 temes. La
[direcció artística](art-direction.md) continua sent la referència de la paleta, la
tipografia, les icones i l'elevació; aquesta pàgina hi afegeix els rols de superfície i
les regles de contrast que els tokens han de complir.

## Rols de superfície

Cada pantalla es compon de dos tons. El **marc** és el to més profund i agrupa el que
serveix per moure's: la finestra, les capçaleres de les subfinestres, les barres d'eines
i el panell de carpetes. El **contingut** és el to més clar i agrupa el que es llegeix:
les llistes i el lector. Els camps fan servir per defecte el to del contingut;
`Field` i les variants `surface="raised"` fan servir la superfície elevada.

| Rol | Token CSS | Utilitat | Ús | Oreneta Light | Oreneta Dark |
|---|---|---|---|---|---|
| Marc | `--me-bg-app`, `--me-bg-header` | `bg-app`, `bg-header` | Finestra, capçaleres, barres, panell de carpetes | `#e3eaf4` | `#0c1526` |
| Contingut | `--me-bg-chats` | `bg-chats` | Llistes, menús flotants | `#fbfcfe` | `#142036` |
| Lector | `--me-bg-chat` | `bg-chat` | Cos del missatge i detall | `#fdfdff` | `#111c30` |
| Superfície elevada | `--me-bg-raised` | `bg-raised` | `Field` i camps amb `surface="raised"`; el fons del redactor (`--me-composer-bg`) pren el mateix valor | `#ffffff` | `#1b2a42` |
| Pas del punter | `--me-bg-hover` | `bg-hover` | Files i botons sota el punter | `#ebf0f8` | `#22314c` |
| Selecció | `--me-bg-active` | `bg-active` | Fila, carpeta o mòdul seleccionat | `#d6e3fb` | `#243a5e` |
| Divisor | `--me-border` | `border-border` | Separadors d'1 px entre subfinestres i files | `#d3dbe8` | `#30415b` |
| Vora de camp | `--me-border-input` | `border-input` | Contorn de camps, desplegables i caselles | `#6b7a93` | `#7d91b4` |
| Barra de mòduls | `--me-bg-sidenav` | `bg-sidenav` | La barra estreta de mòduls, de 769 a 1024 px (des de #354; abans, la barra vertical de comptes i mòduls) | `#15316e` | `#08111f` |

El divisor només separa; no és prou visible per marcar on comença un camp. Per això
els camps, els desplegables i les caselles fan servir la vora de camp, i el divisor es
queda per a les línies entre zones. Les primitives `TextInput`, `SelectInput` i
`Field` (`components/field/Field.tsx`), la casella `.app-checkbox` i el filtre del
panell de carpetes ja la fan servir. La resta de camps que encara porten
`border-border` es migren a mesura que es toquen les pantalles.

Els estats actius que pintaven un tint translúcid de l'accent sobre el marc (la nota
seleccionada, els botons actius del redactor i de la vista del calendari) i els exemples
de Markdown de la barra del redactor passen a la selecció (`bg-active`) i a la
superfície elevada: sobre el marc més profund, el tint baixava el text per sota de
4,5:1, i la selecció ja té el contrast comprovat.

Els menús flotants que es pintaven amb `bg-header` passen a `bg-chats`, com la majoria de
capes flotants, perquè no prenguin el to del marc. No fan servir `bg-raised` perquè en
alguns temes foscos aquest token és translúcid.

## Contrast

La comprovació és a [`lib/themes.test.ts`](../../frontend/src/lib/themes.test.ts) i
s'aplica als 16 temes integrats i a tres paletes personalitzades de mostra (les dues
llavors de l'editor i una paleta neutra). Per a qualsevol altra paleta triada, l'editor
avisa quan el text o l'accent no arriben a 4,5:1:

- El text principal i el secundari, almenys 4,5:1 a cada superfície.
- El text sobre l'accent, almenys 4,5:1 sobre l'accent i sobre l'accent en passar-hi
  el punter.
- La vora de camp, almenys 3:1 a cada superfície (WCAG 1.4.11).
- Els colors d'estat (èxit, avís, perill, informació), almenys 4,5:1 sobre el seu to
  suau, el marc, el contingut i el lector.
- L'accent com a text i com a anell de focus (`--me-accent-fg`), almenys 4,5:1 a cada
  superfície, a tots els temes (4,5:1 compleix també el 3:1 de l'anell). Vegeu
  [L'accent com a text i com a anell](#laccent-com-a-text-i-com-a-anell-311).

«Cada superfície» vol dir el marc, la capçalera, el contingut, el lector, la superfície
elevada, el pas del punter i la selecció. Les superfícies translúcides (el pas del
punter i la superfície elevada d'alguns temes foscos) es resolen sobre el contingut i
sobre el marc, que és on es pinten (`composite` a `lib/color.ts`). Una superfície que
no es pot resoldre no es compta i no es dedueix.

Valors mínims d'Oreneta Light i Dark: vora de camp 3,36:1 i 3,57:1 (sobre la
selecció), accent com a text 4,73:1 i 4,77:1, text secundari 4,72:1 i 5,66:1.

## Temes integrats i personalitzats

Als altres 14 temes integrats, la capçalera pren el to del marc (el fons de la
finestra de cada tema). Set temes tenien el text secundari per sota de 4,5:1 a les seves
pròpies superfícies, i aquest text s'ha enfosquit cap al text principal fins a arribar-hi:

| Tema | Abans | Ara |
|---|---|---|
| Indigo | `#64748b` | `#5a697f` |
| Legacy Green | `#68746e` | `#5e6964` |
| Mist | `#6f8790` | `#516b74` |
| Paper | `#7b817d` | `#5c6463` |
| Dawn | `#897c83` | `#695d67` |
| Honey | `#8b8068` | `#6c624d` |
| Lilac | `#7e7894` | `#635d79` |

Els accents de tots els temes es mantenen. La vora de camp d'aquests 14 temes es deriva:
el divisor de cada tema es mou cap al text principal només fins que arriba a 3:1 a
totes les superfícies.

Els temes personalitzats nous es deriven de la mateixa manera: la capçalera pren el
fons de la finestra, el lector en fosc queda entre el marc i la llista, el text
secundari compleix 4,5:1 a totes les superfícies quan el text principal ho permet i la
vora de camp es deriva com als temes integrats. Els temes personalitzats desats abans
d'aquest canvi conserven tots els colors desats, inclosa la capçalera amb el to del
contingut (continuen sent d'un sol to fins que es tornen a desar); només s'hi afegeix la
vora de camp, calculada a partir dels seus propis colors desats. Si no es pot resoldre
cap superfície desada, el contrast és desconegut i la vora pren el color del text; si ni
el text no arriba a 3:1, la vora també pren el color del text, i l'editor avisa que el text no es
llegeix. Una vora de camp ja desada es conserva tal com és.

## Anell de focus

Un sol anell per a tot el que rep el focus del teclat: 2 px de color d'accent sòlid
(`--me-accent-fg`), a 2 px de l'element (0 px dins dels camps). A la barra estreta de
mòduls, que és fosca, l'anell pren l'extrem clar de la paleta, com les icones (vegeu
[La barra estreta de mòduls](#la-barra-estreta-de-mòduls-354)); a la tira de mòduls,
sobre la subfinestra de carpetes, és el de sempre, dibuixat a dins de cada botó. Abans era l'accent al 75 % d'opacitat, de manera
que el contrast depenia del fons. La casella ja no hi afegeix un halo translúcid propi, i
en passar-hi el punter conserva la vora de camp en lloc de barrejar-la amb l'accent.

## Radis

Cantonades gairebé rectes (D3). Els noms dels tokens no canvien; només els valors:

| Token | Abans | Ara | Ús |
|---|---|---|---|
| `--radius-control-sm` | 8 px | 4 px | Botons petits, camps, elements de menú, caselles |
| `--radius-control` | 12 px | 6 px | Botons, camps, xips, botons d'icona |
| `--radius-panel` | 16 px | 8 px | Targetes, finestres emergents, bombolles |
| `--radius-dialog` | 24 px | 12 px | Diàlegs |

Les files, les subfinestres i la selecció de fila completa sense cantonades arriben amb
les peces de la llista i del panell de carpetes.

## L'accent com a text i com a anell (#311)

Decisió del propietari a #287 (opció A del comentari «DECISION REQUIRED», acceptada a la
PR #295 el 2026-10-18), aplicada a #311. Abans, l'accent pintat com a text (la carpeta
seleccionada, els enllaços) quedava per sota de 4,5:1 en vuit temes integrats (Indigo
Dark, Legacy Green, Mist, Paper, Dawn, Honey, Lilac i Graphite) i l'anell de focus per
sota de 3:1 en tres (Mist, Dawn i Honey). No es canvia cap color d'accent: els temes
heretats conserven els seus colors (#83) i el farciment de l'accent no varia.

### Rols

| Rol | Token | Utilitat | Ús |
|---|---|---|---|
| Farciment de l'accent | `--me-accent` | `bg-accent`, `border-accent`, `bg-accent/10` | Botons plens, caselles marcades, vores i tints translúcids |
| Text sobre l'accent | `--me-accent-text` | `text-on-accent` | El text dibuixat sobre el farciment |
| Accent com a text i anell | `--me-accent-fg` | `text-accent-fg`, `ring-accent-fg`, `border-accent-fg` | L'accent com a text, icona en primer pla o indicador de focus |

`--me-accent-fg` és un token derivat (com `--me-accent-text` i `--me-border-input`): cap
tema no el fixa a mà. S'obté movent l'accent cap al color del text principal, d'1 % en
1 %, només fins que arriba a 4,5:1 a totes les superfícies (les mateixes que es
comproven per al text; vegeu [Contrast](#contrast)). Així conserva el to i només
s'enfosqueix o s'aclareix el necessari. Quan l'accent ja compleix, el valor és
exactament l'accent. Si cap punt entre l'accent i el text no hi arriba, pren el color del
text i l'editor avisa que l'accent no es llegeix; si no es pot resoldre cap superfície,
pren l'accent.

### Quan fer servir cada token

- Text, icones en primer pla (`text-accent-fg`, també amb `hover:`), enllaços del cos del
  missatge i element actiu de la navegació: `accent-fg`.
- Anell o vora que indica el focus (`:focus-visible`, `focus:ring-accent-fg`,
  `focus-within:ring-accent-fg`, `focus:border-accent-fg`) i la vora discontínua de
  deixar anar: `accent-fg`.
- Farciments, vores d'estat seleccionat (també la mostra de color triada) i tints
  translúcids (`bg-accent/10`): continuen amb l'accent, perquè no són text ni indiquen
  el focus.
- Els halos translúcids que fan d'únic indicador de focus (`focus:ring-accent/40` i
  semblants) encara no compleixen 3:1; queden a [Pendent](#pendent).

### Valors

El contrast mínim és el més baix de totes les superfícies del tema que es comproven
(vegeu [Contrast](#contrast)).

| Tema | Accent | `--me-accent-fg` | Contrast abans | Contrast ara |
|---|---|---|---|---|
| Indigo Dark | `#6366f1` | `#8184f3` | 3,27:1 | 4,55:1 |
| Legacy Green | `#0e7a58` | `#0f7555` | 4,26:1 | 4,54:1 |
| Mist | `#0ea5b7` | `#117281` | 2,39:1 | 4,51:1 |
| Paper | `#64748b` | `#566476` | 3,57:1 | 4,52:1 |
| Dawn | `#c06c84` | `#805466` | 2,66:1 | 4,51:1 |
| Honey | `#b07c10` | `#805d17` | 2,77:1 | 4,54:1 |
| Lilac | `#7a5bc4` | `#6a51a8` | 3,71:1 | 4,56:1 |
| Graphite | `#8b9bb4` | `#93a2b9` | 4,16:1 | 4,53:1 |

Els altres vuit temes ja complien i `--me-accent-fg` és el seu accent. L'anell de Mist,
Dawn i Honey passa així de 2,39:1, 2,66:1 i 2,77:1 a més de 4,5:1 sobre aquestes
superfícies.

### Temes personalitzats

Els temes nous deriven `--me-accent-fg` de l'accent i del text triats. Els temes
personalitzats desats abans d'aquest canvi reben el token calculat a partir dels seus
colors desats (accent, text i superfícies); no es reescriu cap color desat, i un
`--me-accent-fg` ja desat es conserva. La prova de `lib/themes.test.ts` ja no té cap
llista d'excepcions: comprova els 16 temes, les paletes de mostra i la restauració.

## La barra estreta de mòduls (#354)

Decisió 4 del propietari a [#352](https://github.com/adilelhaji/oreneta/issues/352): el
color «Barra de mòduls» (`--me-bg-sidenav`) només pinta la barra estreta de mòduls, entre
769 i 1024 px; la tira de mòduls, al peu de la subfinestra de carpetes, pren el color de
la subfinestra. El camp de l'editor de temes es diu «Barra de mòduls» (abans «Navegació
lateral») i el token conserva el nom, de manera que els temes personalitzats desats
conserven el seu valor. La franja `MacTitleBar` de macOS pren el to de la banda superior.

La barra és fosca en els 16 temes integrats. Les seves icones i el seu anell de focus
prenen l'extrem clar de la paleta (`--module-bar-fg`, a `index.css`): el marc
(`--me-bg-app`) als temes clars i el text principal (`--me-text-primary`) als foscos. Hi
arriben a 10,22:1 a Oreneta Light i a 16,07:1 a Oreneta Dark, a 10:1 o més en tots els
temes, i a 6,85:1 o més sota el to del pas del punter (el mateix color al 15 %). Abans, l'anell de la
barra vertical era el farciment de l'accent, i no arribava a 3:1 en quatre temes
(Oreneta Light, 2,03:1; Indigo, Paper i Lilac). El botó actiu és la selecció
(`--me-bg-active`) amb la icona i la barra d'accent en `--me-accent-fg`, que hi arriben a
4,5:1, i el comptador, el text sobre l'accent. Ho comprova `lib/themes.test.ts`.

Un tema personalitzat pot triar una barra clara, on aquest extrem clar no es llegiria.
L'editor encara no ho avisa (vegeu [Pendent](#pendent)).

## Pendent

L'editor de temes personalitzats encara no avisa quan el color «Barra de mòduls» és tan
clar que les icones de la barra estreta no s'hi llegeixen (#354).

`--me-accent-fg` es calcula sobre les superfícies del tema, però encara no sobre la
bombolla de sortida del xat ni sobre els tints d'accent més forts (`bg-accent/15`,
`bg-accent/25`), on queda per sota de 4,5:1 en alguns temes foscos (Oreneta Dark 4,42:1 a
la bombolla). Tampoc no compleixen 3:1 els halos translúcids que fan d'únic indicador de
focus (per exemple a `ConversationSubject`, `ReadingHeaderSummary`,
`ConversationHeader`, `KanbanView` i `FolderSwitcher`). En tots aquests casos el contrast
és igual o millor que abans; es resoldran en una incidència posterior.

Altres punts que queden per a peces posteriors: els camps que encara porten
`border-border` (per exemple els dels assistents d'alta de compte), els diàlegs i el
selector flotant que pinten amb `bg-app` i ara prenen el to del marc (`CalendarList`,
`EventDetails`, `EventEditor`, `AssistantReviewDialog`, `SettingsDialog`) i la targeta
d'alta del xat (`MessagingView`), que pinta amb `bg-header`.

## Verificació

- Proves unitàries: `lib/themes.test.ts` (contrast dels 16 temes, accent com a text i
  anell, icones, pas del punter i anell de la barra estreta de mòduls, tons de marc i contingut, valors aprovats d'Oreneta, derivació i restauració de temes
  personalitzats, sincronia entre `index.css` i el registre), `lib/color.test.ts`
  (`composite`) i `components/design-primitives.test.tsx` (vores dels camps).
- Proves d'entrada de producció: el catàleg de disseny comprova el color sòlid de
  l'anell i la vora dels camps en clar i en fosc; les auditories axe en clar, en fosc i
  en àrab s'han de mantenir en verd a la CI.
- La CI és l'execució de les proves; no hi ha evidència nativa de Windows.
