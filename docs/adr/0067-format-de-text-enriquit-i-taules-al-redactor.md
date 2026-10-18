# ADR-0067: Format de text enriquit i taules al redactor

- Estat: acceptada pel propietari el 2026-10-17 («sí, aprueba la A con esos
  atajos»): l'opció A i tres decisions de dreceres (punt 5): `Mod-Shift-r`
  alinea a la dreta dins de l'editor i fora continua sincronitzant la bústia;
  `Mod-]` i `Mod-[` augmenten i redueixen el sagnat; Tab a l'última cel·la d'una taula hi afegeix una
  fila.
- Afegit en implementar (#274), sense canviar la decisió: la classe
  `oreneta-table` (punt 3), el límit de les cel·les que ocupen més d'una
  columna o fila (punt 2), l'extensió `FormattingShortcuts` i la gestió dels claudàtors escrits amb AltGr (punt 5), la lectura de les taules de maquetació en text pla
  (punt 6) i les conseqüències.
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
  llegir-lo, també la còpia d'Enviats, i deixa passar `style` i `class`.

Avui `htmlToText` no separa les cel·les d'una taula: `<td>a</td><td>b</td>`
dona «ab».

## Decisió

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
- `extension-table` porta `Table`, `TableRow`, `TableHeader`, `TableCell` i
  `TableView`. Fa servir `prosemirror-tables`, que ja és al `bun.lock` (1.8.5,
  MIT) perquè ve amb `@tiptap/pm`. No s'afegeix cap paquet transitiu, però el
  fitxer JavaScript de l'aplicació (bundle) creixerà amb aquest codi, que
  abans no s'importava (`dist/index.js`: 92 246 B sense minimitzar).
- Les mides són les de jsDelivr per a la versió 3.23.6. La mida dins del
  fitxer minimitzat de l'aplicació no s'ha mesurat: la compilació no es pot
  fer en aquest ordinador i la de CI no la publica. Queda pendent.
- Manteniment: la 3.23.6 es va publicar el 2026-05-21 i la darrera versió del
  registre npm és la 3.32.0 (2026-10-13). Totes les peces de tiptap han de
  pujar alhora; aquest canvi no puja de versió.
- El color de fons es fa amb `BackgroundColor` (`<span style="background-color">`)
  i no amb `@tiptap/extension-highlight` (`<mark>`). Així no cal un altre
  paquet i s'evita que `Highlight` llegeixi l'atribut `data-color` tal com
  arriba i el copiï dins de `style`.
- El sagnat de paràgraf no té cap extensió oficial (`@tiptap/extension-indent`
  no existeix a npm). És una extensió pròpia (`indentExtension.ts`), sense cap
  paquet nou (punt 4).
- Tot tiptap és a `docs/soup.md`.

### 2. Neteja de l'HTML que s'envia

- L'esquema continua sent el filtre. Dels elements i atributs nous, només
  poden sortir:
  - `<span style>` amb `font-family`, `font-size`, `color` i
    `background-color`;
  - `text-align` en paràgrafs, encapçalaments i cel·les;
  - `<table>` (amb la classe `oreneta-table` si s'ha fet al redactor i
    l'`style` d'amplada mínima que escriu tiptap), `<colgroup>`, `<col>`,
    `<tbody>`, `<tr>`, `<th>` i `<td>`, amb `colspan` i `rowspan`;
  - el marge del sagnat, en píxels.
- Codi revisat de la 3.23.6:
  - `TextAlign` i l'alineació de cel·la només accepten valors d'una llista
    tancada (`left`, `center`, `right`, `justify`).
  - L'amplada de columna es llegeix amb `parseInt`.
  - `colspan` i `rowspan` es llegeixen sense límit, i el codi de les taules
    recorre una cel·la columna per columna: `colspan="2000000000"` en un
    missatge citat bloquejaria el redactor. Oreneta els llegeix com a enters d'1 a 50
    (`clampSpan`).
  - `Color`, `BackgroundColor`, `FontFamily` i `FontSize` llegeixen el valor
    en brut de l'atribut `style` (`getStyleProperty`, que talla per `;`) i el
    tornen a escriure tal com és. Un valor no pot obrir una declaració nova,
    però pot portar qualsevol cosa: `url(…)`, cometes desaparellades o un text
    molt llarg.
- Per això cada atribut es configura amb un `parseHTML` i un `renderHTML`
  propis que validen el valor i, si no és vàlid, el descarten (el text es
  queda sense aquell estil i conserva el contingut):
  - color i color de fons: `#` amb 3, 4, 6 o 8 xifres hexadecimals, `rgb()` o
    `rgba()` amb números, o un nom de color fet només de lletres;
  - mida: un número amb `pt`, `px`, `em` o `%`, dins d'un interval tancat per
    unitat;
  - tipus de lletra: fins a 10 noms separats per comes, fets de lletres,
    xifres, espais, `_` i `-`, sols o entre cometes aparellades, en 200
    caràcters com a màxim;
  - en tots: cap `url(`, `\`, `expression`, `var(`, `;`, `<`, `>`, `{`, `}`
    ni comentari de CSS.
- Els valors de la barra d'eines surten de llistes fixes. La validació serveix
  per a l'HTML enganxat i per al que es carrega en reprendre un esborrany, en
  respondre o en reenviar.
- El nucli no neteja l'HTML que s'envia: no ho fa avui i fer-ho seria un
  canvi de contracte. Es pot fer més endavant, en una altra incidència.
- Proves: cada valor no vàlid es descarta, i un HTML hostil enganxat
  (`<script>`, `onclick`, `style` amb `url()`) no arriba a l'HTML enviat.

### 3. Compatibilitat amb els clients

- `inlineRichStyles` afegeix a l'HTML que s'envia estils en línia:
  - a les taules, `border-collapse`, la vora i el farciment de `td` i `th`, i
    `margin: 0` als paràgrafs de les cel·les, com a l'editor;
  - al text amb color de fons i sense color propi, un color fosc, perquè un
    client en mode fosc no el torni clar sobre el fons pàl·lid;
  - el marge del sagnat, amb costats físics: `margin-left` en text d'esquerra
    a dreta i `margin-right` en text de dreta a esquerra, com les citacions
    (ADR-0061).
- Només porten graella les taules fetes al redactor, que es marquen amb la
  classe `oreneta-table` (també a l'editor, amb una vista pròpia de la taula).
  Una taula que arriba amb un missatge citat o enganxat sol ser de maquetació
  i no en porta; una que va sortir d'Oreneta torna amb la classe i la
  conserva. És una classe, i no un atribut `data-*`, perquè ammonia conserva
  `class`: un esborrany reobert des del servidor conserva la graella.
- Les taules es fan sense redimensionar columnes (`resizable: false`):
  l'HTML queda més senzill i sense amplades fixes.
- La comprovació en clients reals (Outlook, Gmail, Apple Mail) és evidència
  N4/N5 i queda pendent. Les proves automàtiques comproven l'HTML que es genera.

### 4. Sagnat de paràgraf

- Atribut global `indent` (0 a 8) a `paragraph` i `heading`. A l'editor es
  pinta amb CSS a partir de `data-indent`; en enviar, `inlineRichStyles` el
  converteix en `margin-left` o `margin-right` de 40 px per nivell i treu
  `data-indent`.
- Es llegeix de `data-indent` o, si no hi és, del marge en píxels dividit per
  40. L'HTML d'un missatge llegit passa per ammonia (`engine.rs`,
  `attach_html`), que no deixa passar els atributs `data-*`.
- «Augmenta el sagnat» i «Redueix el sagnat» fan servir `sinkListItem` i
  `liftListItem` dins d'una llista, i l'atribut `indent` fora.

### 5. Dreceres

Decidit pel propietari el 2026-10-17:

- Alineació: `Mod-Shift-l`, `Mod-Shift-e`, `Mod-Shift-r` i `Mod-Shift-j`.
  `Mod-Shift-r` també és `mail.sync` (`lib/shortcuts.ts`): dins de l'editor
  alinea a la dreta i fora continua sincronitzant.
- Sagnat: `Mod-]` i `Mod-[`.
- A les taules, Tab i Maj+Tab passen d'una cel·la a l'altra i Tab a l'última
  cel·la afegeix una fila (comportament de l'extensió). Les fletxes en
  surten.

Com s'aplica:

- Una extensió pròpia (`FormattingShortcuts`, prioritat 1000) atén aquestes
  combinacions abans que cap altra assignació de tecles, també la de
  `TextAlign`. L'editor atura l'esdeveniment de tecla (`stopPropagation`)
  perquè el gestor de dreceres de la finestra no el vegi.
- En els teclats català, castellà, francès o alemany, `[` i `]` s'escriuen amb
  AltGr, que arriba com a Ctrl+Alt. Per a l'editor, un claudàtor escrit amb AltGr és idèntic a
  Ctrl+AltGr+claudàtor, i prendre'l com a drecera impediria escriure'l (Codex,
  #298). Per això cap drecera de format no actua amb Alt (ni AltGr) premuda:
  en aquests teclats, el sagnat es fa amb la barra d'eines. El 2026-10-18 el propietari havia acceptat que el sagnat
  funcionés amb AltGr+claudàtor; com que no es pot fer sense impedir que
  s'escriguin els claudàtors, aquesta decisió es retira.
- L'editor es queda aquestes combinacions encara que la persona hagi assignat
  una drecera de l'aplicació a alguna d'elles (`lib/shortcuts.ts` permet
  canviar-les). Les dreceres per defecte de l'aplicació no en fan servir cap
  llevat de `Mod-Shift-r`.
- Els editors de signatures i de notes no carreguen aquestes extensions: allà
  `Mod-Shift-r` continua sincronitzant la bústia.

### 6. Alternativa de text pla

- `htmlToText` escriu una taula de dades amb una fila per línia i les cel·les
  separades per ` | `, apartada com un paràgraf. Una cel·la buida queda buida
  entre els separadors; una fila sense cap text no s'escriu; el títol
  (`<caption>`) va a sobre.
- Una taula de dades és una feta al redactor (classe `oreneta-table`) o una
  sense cap taula a dins i sense cap cel·la amb més d'un bloc o amb salts de línia. Les altres són
  de maquetació (un butlletí o una signatura citats): les seves cel·les es
  llegeixen com a paràgrafs, perquè posar-les en una línia faria il·legible
  el missatge citat.
- Els colors, els tipus de lletra, les mides, l'alineació i el sagnat no es
  passen al text pla: el text pla no els pot representar i el contingut no
  canvia.
- Proves de `htmlToText` per a cada cas: taula amb capçalera, cel·la buida,
  `colspan`, taula dins d'una citació, taula de maquetació, títol, fila buida i
  paràgraf sagnat.

## Opcions considerades

- **A. Extensions oficials (acceptada).** Tres paquets MIT del mateix
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

- Al redactor sobreviu més formatació del contingut reenviat o enganxat: els
  quatre estils validats de `<span>`, l'alineació, el sagnat en píxels i les
  taules. Abans les taules es desfeien en paràgrafs i la resta es perdia.
- L'HTML enviat porta la classe `oreneta-table` a les taules fetes al
  redactor. Fa reconeixible que el missatge s'ha escrit amb Oreneta; és el
  preu de conservar la graella en reobrir un esborrany. Ja ho feien els
  identificadors de les imatges en línia (`oreneta-image-…@oreneta`,
  `createInlineId`); `data-indent` no surt.
- Al redactor, el sagnat d'un paràgraf de dreta a esquerra es veu a
  l'esquerra quan la interfície és d'esquerra a dreta (`margin-inline-start`
  segueix la direcció de l'editor); el missatge enviat el porta a la dreta.
- Una taula enganxada des d'un full de càlcul arriba sense graella i la barra d'eines no té cap ordre per posar-n'hi.
- Noves cadenes d'interfície a tots els `locales/*.json`.
