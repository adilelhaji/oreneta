# ADR-0067: Format de text enriquit i taules al redactor

- Estat: proposada. Cal la decisió del propietari abans d'escriure codi: afegeix
  dependències noves.
- Data: 2026-10-17.
- Abast: #274 (fila SET-10, pare #88). Només el redactor de l'aplicació
  d'escriptori. En queden fora l'editor de signatures, l'editor de notes, el
  mòbil i l'actualització de tiptap a una versió més nova.

## Context

El redactor fa servir tiptap 3.23.6 amb `@tiptap/starter-kit`,
`@tiptap/extension-image` i `@tiptap/extension-link`
(`frontend/package.json`). No té tipus de lletra, mida, color del text, color
de fons, alineació, sagnat de paràgraf ni taules. Les llistes ja es poden
sagnar: `ListItem` i `ListKeymap` (de l'starter-kit) porten `sinkListItem` i
`liftListItem`.

Com surt avui l'HTML:

- L'editor desa `editor.getHTML()`. ProseMirror només conserva els nodes, les
  marques i els atributs de l'esquema: la resta (elements, `on*`, `style`) es
  perd en enganxar o carregar contingut.
- Abans d'enviar, `inlineRichStyles` (`composerHelpers.ts`) hi posa estils en
  línia per a les citacions, els enllaços i el codi, amb costats físics
  (ADR-0061).
- `composedPayload` (`states/compose.ts`) envia l'HTML i, com a alternativa de
  text pla, `htmlToText(html)` (`lib/html.ts`). El nucli (`smtp.rs`,
  `build_message`) en fa un `multipart/alternative` amb les dues parts i no
  torna a netejar l'HTML que s'envia. ammonia (`parse.rs`) neteja l'HTML en
  llegir-lo, també la còpia d'Enviats, i deixa passar `style`.

Avui `htmlToText` no separa les cel·les d'una taula: `<td>a</td><td>b</td>`
dona «ab».

## Decisió proposada

### 1. Paquets

Tres extensions oficials de tiptap, del mateix monorepositori
(`github.com/ueberdosis/tiptap`), fixades a la versió exacta que ja tenim
(les dependències entre iguals, peer dependencies, de tiptap demanen
`3.23.6` exacte):

| Paquet | Versió | Llicència | `dist/index.js` (ESM sense minimitzar) | Dependències |
|---|---|---|---|---|
| `@tiptap/extension-text-style` | 3.23.6 | MIT | 10 380 B | cap; només `@tiptap/core` com a dependència entre iguals |
| `@tiptap/extension-text-align` | 3.23.6 | MIT | 2 238 B | cap; només `@tiptap/core` |
| `@tiptap/extension-table` | 3.23.6 | MIT | 21 595 B | cap; `@tiptap/core` i `@tiptap/pm` |

- `extension-text-style` porta `TextStyle`, `FontFamily`, `FontSize`,
  `Color` i `BackgroundColor`. Els paquets `@tiptap/extension-color` i
  `@tiptap/extension-font-family` només el tornen a exportar: no cal
  instal·lar-los.
- `extension-table` porta `Table`, `TableRow`, `TableHeader` i `TableCell`.
  Fa servir `prosemirror-tables`, que ja és al `bun.lock` (1.8.5, MIT) perquè
  ve amb `@tiptap/pm`. No s'afegeix cap paquet transitiu, però el fitxer
  JavaScript de l'aplicació (bundle) creixerà amb aquest codi, que avui no s'importa
  (`dist/index.js`: 92 246 B sense minimitzar).
- Les mides són les de jsDelivr per a la versió 3.23.6. La mida real dins del
  fitxer minimitzat de l'aplicació es mesurarà a la PR d'implementació.
- Manteniment: la 3.23.6 es va publicar el 2026-05-21 i la darrera versió del
  registre npm és la 3.32.0 (2026-10-13). Totes les peces de tiptap han de
  pujar alhora; aquesta proposta no puja de versió.
- El color de fons es fa amb `BackgroundColor` (`<span style="background-color">`)
  i no amb `@tiptap/extension-highlight` (`<mark>`). Així no cal un altre
  paquet i s'evita que `Highlight` llegeixi l'atribut `data-color` tal com
  arriba i el copiï dins de `style`.
- El sagnat de paràgraf no té cap extensió oficial (`@tiptap/extension-indent`
  no existeix a npm). Es fa una extensió pròpia al repositori, sense cap
  paquet nou (punt 4).
- Es registren a `docs/soup.md`. tiptap encara no hi és; s'hi afegeix sencer
  (editor i extensions, 3.23.6, MIT).

### 2. Neteja de l'HTML que s'envia

- L'esquema continua sent el filtre: dels elements nous, només poden sortir
  `<span style>`, `text-align` en blocs i cel·les,
  `<table>`, `<colgroup>`, `<col>`, `<tbody>`, `<tr>`, `<th>`, `<td>`,
  `colspan` i `rowspan`.
- Codi revisat de la 3.23.6:
  - `TextAlign` i l'alineació de cel·la només accepten valors d'una llista
    tancada (`left`, `center`, `right`, `justify`).
  - L'amplada de columna es llegeix amb `parseInt`.
  - En canvi, `Color`, `BackgroundColor`, `FontFamily` i `FontSize` llegeixen
    el valor en brut de l'atribut `style` (`getStyleProperty`, que talla per
    `;`) i el tornen a escriure tal com és. Un valor no pot obrir una
    declaració nova, però pot portar qualsevol cosa: `url(…)`, cometes
    desaparellades o un text molt llarg.
- Per això cada atribut es configura amb un `parseHTML` propi que valida el
  valor i, si no és vàlid, el descarta (el text es queda sense aquell estil i
  conserva el contingut):
  - color i color de fons: `#rgb`, `#rrggbb`, `rgb()` o `rgba()` amb números,
    o un nom de color fet només de lletres;
  - mida: un número amb `pt`, `px`, `em` o `%`, dins d'un interval tancat;
  - tipus de lletra: noms separats per comes, fets de lletres, xifres, espais,
    guionets i cometes aparellades, amb una llargada màxima;
  - en tots: cap `url(`, `\`, `expression`, `var(` ni `;`.
- Els valors de la barra d'eines surten de llistes fixes. La validació serveix
  per a l'HTML enganxat i per al que es carrega en reprendre un esborrany o en
  reenviar.
- El nucli no neteja l'HTML que s'envia: no ho fa avui i fer-ho seria un
  canvi de contracte. Es pot fer més endavant, en una altra incidència.
- Proves: cada valor no vàlid es descarta, i un HTML hostil enganxat
  (`<script>`, `onclick`, `style` amb `url()`) no arriba a l'HTML enviat.

### 3. Compatibilitat amb els clients

- `inlineRichStyles` hi afegeix estils en línia per a les taules
  (`border-collapse`, i vora i farciment a `td` i `th`) i el marge del
  sagnat, amb costats físics: `margin-left` en text d'esquerra a dreta i
  `margin-right` en text de dreta a esquerra, com les citacions (ADR-0061).
- Les taules es fan sense redimensionar columnes (`resizable: false`):
  l'HTML queda més senzill i sense amplades fixes.
- La comprovació en clients reals (Outlook, Gmail, Apple Mail) és evidència
  N4/N5 i queda pendent. Les proves automàtiques comproven l'HTML que es genera.

### 4. Sagnat de paràgraf

- Atribut global `indent` (0 a 8) a `paragraph` i `heading`. A l'editor es
  pinta amb CSS; en enviar, `inlineRichStyles` el converteix en
  `margin-left` o `margin-right` de 40 px per nivell.
- Es llegeix de `data-indent` o, si no hi és, del marge en píxels dividit per
  40. L'HTML d'un missatge llegit passa per ammonia (`engine.rs`,
  `attach_html`), que no deixa passar els atributs `data-*`.
- «Augmenta el sagnat» i «Redueix el sagnat» fan servir `sinkListItem` i
  `liftListItem` dins d'una llista, i l'atribut `indent` fora.

### 5. Dreceres

- `TextAlign` porta `Mod-Shift-l`, `Mod-Shift-e`, `Mod-Shift-r` i
  `Mod-Shift-j`. `Mod-Shift-r` xoca amb `mail.sync` (`lib/shortcuts.ts`). La
  proposta és que dins de l'editor guanyi l'alineació i que la PR ho
  comprovi amb una prova.
- Sagnat: `Mod-]` i `Mod-[`, que avui no fa servir cap drecera
  de `lib/shortcuts.ts`.
- A les taules, Tab i Maj+Tab passen d'una cel·la a l'altra i Tab a l'última
  cel·la afegeix una fila (comportament de l'extensió). Les fletxes en
  surten.

### 6. Alternativa de text pla

- `htmlToText` separa les cel·les amb ` | ` i les files amb un salt de línia.
  La taula és un paràgraf, com fins ara. Una cel·la buida queda buida entre els
  separadors.
- Els colors, els tipus de lletra, les mides, l'alineació i el sagnat no es
  passen al text pla: el text pla no els pot representar i el contingut no
  canvia.
- Proves de `htmlToText` per a cada cas: taula amb capçalera, cel·la buida,
  `colspan`, taula dins d'una citació i paràgraf sagnat.

## Opcions considerades

- **A. Extensions oficials (recomanada).** Tres paquets MIT del mateix
  projecte i versió, sense dependències transitives noves, amb la validació
  del punt 2.
- **B. Tot fet al repositori.** Marques i atributs propis sobre `@tiptap/core`,
  i taules sobre `@tiptap/pm/tables`, que ja és una dependència directa. Cap
  paquet nou, però caldria mantenir aquí l'esquema i les ordres de les
  taules, que l'extensió oficial ja resol.
- **C. A amb `Highlight` per al color de fons.** Rebutjada: un paquet més,
  `data-color` en brut i un element (`<mark>`) que no hem comprovat en els
  clients de correu.
- **D. Ajornar-ho.** La fila SET-10 queda incompleta.

## Conseqüències

- Més formatació del contingut reenviat o enganxat sobreviu al redactor: els
  cinc estils validats de `<span>` i l'alineació. Abans es perdien tots.
- Noves cadenes d'interfície a tots els `locales/*.json`.
- La PR d'implementació també afegeix proves de cada ordre i de l'HTML
  enviat, actualitza la documentació i afegeix una nota al registre
  d'acceptació, sense canviar cap estat.
