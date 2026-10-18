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
| Barra de mòduls | `--me-bg-sidenav` | `bg-sidenav` | Barra de comptes i mòduls | `#15316e` | `#08111f` |

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
- L'accent com a text, almenys 4,5:1, i l'anell de focus, almenys 3:1, a cada
  superfície, llevat dels temes de la secció [Pendent](#pendent).

«Cada superfície» vol dir el marc, la capçalera, el contingut, el lector, la superfície
elevada, el pas del punter i la selecció. Les superfícies translúcides (el pas del
punter i la superfície elevada d'alguns temes foscos) es resolen sobre el contingut i
sobre el marc, que és on es pinten (`composite` a `lib/color.ts`). Una superfície que
no es pot resoldre no es compta i no es dedueix.

Valors mínims d'Oreneta Light i Dark: vora de camp 3,36:1 i 3,57:1 (sobre la
selecció), accent 4,73:1 i 4,77:1, text secundari 4,72:1 i 5,66:1.

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

Un sol anell per a tot el que rep el focus del teclat: 2 px d'accent sòlid, a 2 px de
l'element (0 px dins dels camps). Abans era l'accent al 75 % d'opacitat, de manera
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

## Pendent

Decisió del propietari demanada a #287 (comentari «DECISION REQUIRED»). La condició de
D2 («sempre que cada tema compleixi el contrast AA») encara no es compleix en els punts
següents.

En vuit temes integrats l'accent queda per sota de 4,5:1 com a text (la carpeta
seleccionada, els enllaços), i en tres d'ells també per sota de 3:1 com a anell de
focus. Ja era així abans d'aquest canvi. Arreglar-ho vol dir canviar el color d'accent
d'un tema que algú ja ha triat, de manera que és una decisió del propietari (#287).
Mentrestant, la prova enumera aquests temes i falla si n'hi entra un de nou o si un
dels enumerats ja compleix.

| Tema | Accent | Contrast mínim | Anell per sota de 3:1 |
|---|---|---|---|
| Indigo Dark | `#6366f1` | 3,27:1 | No |
| Legacy Green | `#0e7a58` | 4,26:1 | No |
| Mist | `#0ea5b7` | 2,39:1 | Sí |
| Paper | `#64748b` | 3,57:1 | No |
| Dawn | `#c06c84` | 2,66:1 | Sí |
| Honey | `#b07c10` | 2,77:1 | Sí |
| Lilac | `#7a5bc4` | 3,71:1 | No |
| Graphite | `#8b9bb4` | 4,16:1 | No |

L'anell de focus sobre la barra de mòduls (`--me-bg-sidenav`) tampoc no arriba a 3:1 en
alguns temes, Oreneta Light inclòs (2,03:1). Aquesta barra no forma part de les
superfícies comprovades i canvia amb la peça del selector de mòduls, que necessita
ADR; el seu anell es resol allà.

Altres punts que queden per a peces posteriors: els camps que encara porten
`border-border` (per exemple els dels assistents d'alta de compte), els diàlegs i el
selector flotant que pinten amb `bg-app` i ara prenen el to del marc (`CalendarList`,
`EventDetails`, `EventEditor`, `AssistantReviewDialog`, `SettingsDialog`) i la targeta
d'alta del xat (`MessagingView`), que pinta amb `bg-header`.

## Verificació

- Proves unitàries: `lib/themes.test.ts` (contrast dels 16 temes, tons de marc i
  contingut, valors aprovats d'Oreneta, derivació i restauració de temes
  personalitzats, sincronia entre `index.css` i el registre), `lib/color.test.ts`
  (`composite`) i `components/design-primitives.test.tsx` (vores dels camps).
- Proves d'entrada de producció: el catàleg de disseny comprova el color sòlid de
  l'anell i la vora dels camps en clar i en fosc; les auditories axe en clar, en fosc i
  en àrab s'han de mantenir en verd a la CI.
- La CI és l'execució de les proves; no hi ha evidència nativa de Windows.
