# De dreta a esquerra (#226)

Fila SET-27 del registre d'acceptació (General → Idioma). Decisions:
[ADR-0061](../adr/0061-right-to-left-layout.md).

Codi: `frontend/src/lib/direction.ts`, `lib/physicalDirection.ts` (el
guardià), `states/settings.ts` (`applyDocumentLanguage`),
`components/composer/composerHelpers.ts` (`inlineRichStyles`, el correu que
surt), `index.css`.

## Com s'escriu un component

- **Costats lògics sempre:** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `border-s`/`border-e`, `rounded-s`/`rounded-e` (i `rounded-ss/se/es/ee`),
  `text-start`/`text-end`; en CSS, `margin-inline-start`,
  `inset-inline-end`, etc. `bun test` falla amb un `ml-2`, un `left-0` o un
  `paddingLeft` nou a `src/components` o `App.tsx`. No mira les
  coordenades en objectes `style`, ni `src/lib`, ni `index.css`.
- **Quan no hi ha forma lògica** (`translate-x`, una ombra interior),
  s'escriu l'altra direcció al costat: `translate-x-4 rtl:-translate-x-4`, o
  una regla `[dir='rtl']` a `index.css`.
- **Una excepció és una decisió:** va a `ALLOWED` a
  `lib/physicalDirection.test.ts` amb el seu motiu, i la prova avisa si es deixa
  de fer servir.
- **Text de les persones:** `dir="auto"` a l'element que el conté
  només a ell (i que el talla amb `truncate`), `<bdi>` si va dins d'una línia amb
  text de la interfície. S'alinea amb la interfície per si sol. Diversos noms
  en una frase: `formatNameList` (o `nameSeparator` amb un `<bdi>` per nom).
- **Text llarg que algú ha escrit:** `dir="auto"` i la classe
  `bidi-plaintext` (o `.tiptap-body`) donen a cada paràgraf la seva pròpia
  direcció. En un camp, `dir={valor ? 'auto' : undefined}`: buit, segueix la
  interfície.
- **Codi, registres, peticions exactes:** `dir="ltr"`.
- **Fletxes com a text:** `forwardArrow()` / `backArrow()`, no «→» / «←».

## El que mira la direcció en temps d'execució

| Què | Com |
|---|---|
| Fletxes laterals a les pestanyes i als grups d'opcions | `handleGroupArrowKeys` (llegeix la direcció de l'element) |
| Fletxes del visualitzador d'imatges | `inlineArrowStep` amb `documentDirection()` |
| Separadors de subfinestres | `PaneResizer` (ADR-0059) |
| Menús contextuals i desplegables | `FloatingContextMenu` + `startEdgeX`, `endAlignedX`, `besideEndX`, `flyoutX` |
| Menú ràpid, finestra de gramàtica | `menuLeft` |
| Missatges HTML al seu marc | `applyContentDirection` (`dir="auto"` a cada bloc de text si el missatge no en declara cap) |
| Correu que surt | `markRightToLeftBlocks` des d'`inlineRichStyles` (`dir="rtl"` i citació amb la barra a la dreta) |

F6 i Maj+F6 entre les regions de la finestra no depenen de la direcció: segueixen
l'ordre del marc, que és el mateix en dreta a esquerra (ADR-0068 §6,
[app-regions.md](app-regions.md)).

## Icones

Es reflecteixen en mode de dreta a esquerra, per la seva classe de Lucide
(`index.css`): fletxes esquerra/dreta, xebrons, `corner-down-*`, respon, reenvia,
desfés/refés, envia, citació de text, entrar/sortir, subfinestres laterals,
llistes i ajust de línia. Una icona amb una classe `rotate-*` o `no-mirror` no
es reflecteix; un xebró de desplegar amb `transition-transform` es gira 180°.

## Proves

- `lib/direction.test.ts`, `lib/physicalDirection.test.ts`: la lògica, la
  direcció dels missatges (un butlletí amb un preencapçalament en àrab continua
  d'esquerra a dreta) i el guardià.
- `components/composer/composerHelpers.test.ts`: el correu que surt; el
  d'esquerra a dreta, idèntic byte a byte.
- `components/readingDirection.test.tsx`, i les proves de pestanyes i grups
  a `TaskLists`, `CalDavCalendars` i `Categories`: teclat i col·locació d'un
  menú.
- `components/mixedDirection.test.tsx`: assumpte en alfabet llatí a la interfície
  àrab i assumpte en àrab a l'anglesa, amb la direcció resultant; canvi d'idioma
  sense recarregar.
- `e2e/startup.e2e.ts` («#226»), al punt d'entrada de producció en àrab:
  - correu, lector i editor de missatges a 600, 1024 i 1440 px, en tema clar i
    fosc, al 100 % i al 200 % (zoom propi, #181), amb axe;
  - persones, tasques, notes, calendari, xat i configuració a 600 i 1024 px, en
    els dos temes, sense desbordar per cap costat i amb axe;
  - un menú contextual obert al costat de la vora dreta: sencer i sense
    etiquetes partides;
  - la tornada a l'anglès sense recarregar, i un assumpte en àrab a la interfície
    anglesa.
- `e2e/startup.e2e.ts` («#306»): F6 i Maj+F6 recorren les regions en el mateix
  ordre en àrab que en anglès i en català, i les regles de regions d'axe no
  troben res a la bústia ni a cap mòdul en àrab.
