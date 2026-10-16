# Direcció artística

La [referència del flux de correu](mail-reference.md) (#32) concreta aquesta
direcció amb escenes sintètiques i navegables de safata d'entrada, lector,
redactor, taula, selecció i error. És un objectiu de comparació, no una
afirmació que la producció ja fa servir el redisseny. La producció adopta els
modes convencionals existents de llista i lector mitjançant els
[valors per defecte del correu](mail-defaults.md) (#84); el poliment detallat
de la disposició continua a part. El
[lliurament dels controls compartits](shared-controls.md) (#152) aplica aquesta
direcció als controls i a les respostes comunes; #33 continua obert per a la
resta de pantalles.

Una referència escrita i comprovable de com ha de ser la interfície: la direcció
sobre la qual es construeix cada incidència de disseny posterior a aquesta, en
lloc que cada pantalla torni a deduir la seva pròpia resposta.

Existeix perquè una cerca amb grep a l'arbre actual va trobar què passa quan no
n'hi ha: 385 usos d'una classe de paleta de Tailwind (`rose`, `amber`,
`emerald`, `red`, `white`, `black`) fora dels tokens de disseny del tema,
17 ombres lluminoses tenyides amb el color d'accent, 14 transformacions
d'escala en passar-hi el punter o en activar, 20 usos de desenfocament
(blur/backdrop-blur), 12 mides d'icona diferents, 6 gruixos de traç i 10 punts
de ruptura responsius diferents. Res no és incorrecte en cap lloc concret, però
tot plegat és una deriva que ningú no podia veure, component a component. L'escala
tipogràfica, els radis, l'elevació i les durades del moviment que ja són
tokens a [`frontend/src/index.css`](../../frontend/src/index.css) van
passar pel mateix problema i la mateixa solució (vegeu els commits `design:`
de setembre del 2026); aquesta pàgina anomena els graons que encara no s'han
convertit en tokens i les decisions d'identitat que mai no s'havien escrit
enlloc.

## Paleta

Adopció a l'aplicació: [#177 coherència de pantalles](screen-consistency.md)
aplica els tokens existents, l'escala d'icones, l'elevació i el moviment als
punts d'ús de les pantalles. Els recomptes anteriors descriuen l'auditoria
històrica, no la feina pendent.

La icona de l'aplicació (`assets/oreneta.svg`) és una oreneta de color cobalt
sobre blau marí (`#2E63F0` i `#15316E`), i la pàgina de presentació fa servir
el mateix blau. Els [valors per defecte de cobalt](cobalt-themes.md)
implementen aquesta paleta per als perfils nous. Les seleccions existents
d'Indigo i del verd antic continuen disponibles sense reescriure la paleta.
Els colors objectiu són:

| Token | Clar | Fosc | Ús |
|---|---|---|---|
| `accent` | `#2056dd` | `#7ea6ff` | Interactiu, selecció, l'únic color saturat d'una pantalla |
| `bg-sidenav` | Blau marí proper a `#15316e` | Blau marí gairebé negre | La barra de comptes |
| Neutres | Blanc trencat amb un to fred lleu, no `#fff` pur | Blau marí gairebé negre, no `#000` pur | Tota la resta |

### Tokens semàntics

Gairebé tots els 385 usos fixos anteriors són una de quatre idees (èxit, avís,
perill, informació) expressades amb un nom de color de Tailwind en lloc d'un
token. Cal afegir quatre tokens, cadascun amb un parell de valors clar
i fosc, a cada tema i a la sortida derivada de l'editor de temes personalitzats
a [`lib/themes.ts`](../../frontend/src/lib/themes.ts):

```
--me-success / --me-success-soft
--me-warning / --me-warning-soft
--me-danger  / --me-danger-soft
--me-info    / --me-info-soft
```

La variant `-soft` és el to que es fa servir per a un fons o una etiqueta; el
token sense sufix és el color de la icona, del text o de la vora. Això
reprodueix com ja funcionen `accent` / `accent-hover`. Migrar els 385 punts
d'ús a aquests tokens és una incidència separada i mecànica, amb la
mateixa forma que la migració de 311 punts d'ús per la qual van passar els
tokens originals de l'escala tipogràfica.

#83 afegeix aquestes posicions als 16 temes integrats i a les paletes
personalitzades, a més de `--me-accent-text` per a controls emplenats llegibles.
Els punts d'ús existents amb colors d'estat fixos encara requereixen la
migració separada de #33; que els tokens estiguin disponibles no demostra
que cada pantalla els hagi adoptat.

## Tipografia

L'escala de sis graons d'`index.css` (de `text-2xs` a `text-title`, de 10 a
16 px) es queda com està: és correcta i res d'aquí no la canvia. Tanmateix,
s'atura als 15 px, i tres llocs ja necessiten més i estan improvisant:
l'etiqueta del mes o del període del calendari, el titular de la pantalla de
benvinguda i qualsevol títol futur d'estat buit més gran que l'actual de 14 px
per defecte. Cal afegir tres graons de capçalera per sobre de l'escala
existent:

| Token | Mida | Ús |
|---|---|---|
| `text-heading-sm` | 18 px | Capçaleres de secció dins d'un Panel (grups de configuració, barra lateral del calendari) |
| `text-heading` | 22 px | Títols de diàleg i de pantalla que necessiten més presència que la que dona `text-title` (15 px): la pantalla de benvinguda, un estat buit a pàgina completa |
| `text-heading-lg` | 28 px | L'únic lloc o els dos llocs on un nombre o un titular és el centre de la pantalla |

La mateixa regla que l'escala existent: ara cap element de la pantalla no té una
mida que no sigui un d'aquests nou graons.

## Icones

Les icones de [Lucide](https://lucide.dev) es fan servir actualment amb 12 mides
diferents (de 7 a 26 px) i 6 gruixos de traç. Cal reduir-les a tres mides i un
sol gruix:

| Token | Mida | Traç | Ús |
|---|---|---|---|
| `icon-sm` | 14 | 1.75 | En línia amb `text-caption`/`text-ui`, elements de menú, accions de fila |
| `icon-md` | 16 | 1.75 | Botons, la majoria d'icones autònomes |
| `icon-lg` | 20 | 1.75 | Capçaleres de diàleg, marques d'estat buit |

Dues excepcions queden fora de l'escala expressament i no s'han de documentar
com a tokens: les icones de 7 px dins de les miniatures de temes i fons
d'escriptori, que són un *dibuix* d'una icona de 14 px a escala de miniatura,
no una mida de text; i qualsevol icona la mida de la qual depèn de la
configuració de la mida del text del missatge del lector, que segueix aquesta
configuració per definició.

## Elevació

Els dos nivells existents, `shadow-raised` (un element elevat sobre la seva
superfície) i `shadow-overlay` (un element que sura sobre tota la pàgina), són
correctes en mode clar i es llegeixen malament en mode fosc, on una ombra negra
sobre un fons gairebé negre és pràcticament invisible. El mode fosc ha
d'expressar els mateixos dos nivells mitjançant la **superfície**, no l'ombra:

- `shadow-raised` en mode fosc: una superfície un graó més clara que el seu
  fons (que ja és com funciona `--me-bg-raised` al tema fosc per defecte) més
  una vora fina d'1 px amb alfa baixa, no una ombra més forta.
- `shadow-overlay` en mode fosc: es manté l'ombra (una capa flotant sobre el
  contingut necessita de debò la separació visual que dona una ombra, encara
  que sigui tènue), però acompanyada de la mateixa vora fina.

Això és descriptiu, no un mecanisme nou: ja és com es comporten
`--me-bg-raised` i `--me-border` al tema fosc per defecte; aquesta pàgina
simplement ho formula com a regla perquè un tema o un component nou ho segueixi
expressament.

## Moviment

Hi ha dues durades, `--duration-fast` (120 ms, canvis d'estat sota el punter) i
`--duration-base` (200 ms, elements que apareixen), i
`prefers-reduced-motion` ja les redueix totes dues a zero arreu. Això es queda
exactament com està. El que no es queda: tres efectes que es fan servir ara i
que no formen part d'aquest sistema.

### El que aquesta aplicació no fa

S'anomenen explícitament perquè es puguin comprovar en la revisió, no només
donar per suposats:

- **Sense resplendor.** `shadow-accent/*` (una ombra de color feta servir com
  a ressaltat) no existeix en els dos nivells d'elevació anteriors i no s'ha de
  reintroduir. Un estat actiu o seleccionat és un to i una vora, no una
  resplendor.
- **Sense escala en passar-hi el punter o en activar**, excepte en elements
  que es poden arrossegar de debò (una targeta del kanban, un element
  ordenable de la barra), on l'escala comunica que «s'està agafant». Un botó
  canvia de color en passar-hi el punter; no creix ni s'encongeix.
- **Sense desenfocament ni desenfocament del fons** com a halo decoratiu darrere
  d'una icona o d'una targeta. El desenfocament es reserva per a un fons real de
  superposició (un diàleg darrere del seu vel), que ja és un comportament
  documentat de `Dialog`, no un efecte per component.
- **No més de tres punts de ruptura responsius.** Avui hi ha deu valors
  `max-[Npx]` / `min-[Npx]` diferents; una incidència posterior n'anomena tres
  (un límit per a mòbil, un per a dues subfinestres i un per a tres
  subfinestres) com a tokens de `@theme` i hi migra tots els valors
  arbitraris.

## On es troba

Enllaçat des del catàleg de disseny de la paleta d'ordres
([`DesignCatalogue.tsx`](../../frontend/src/components/dialog/DesignCatalogue.tsx)),
al costat dels estats de components que documenta: el catàleg mostra *què*
existeix avui; aquesta pàgina explica *per què* ha de tenir aquest aspecte i què
encara no s'hi ha posat al dia.
