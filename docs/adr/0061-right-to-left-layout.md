# ADR-0061: Disseny de dreta a esquerra per a l'àrab

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #226 en l'opció més prudent); pendent de revisió del
  propietari al final del pla.
- Data: 2026-10-16.
- Abast: #226, filla de #37 (fila SET-27 del llibre de paritat, «General →
  Idioma» d'eM Client 10.4). L'esborrany #198 es va fer servir només com a
  referència de quins components calia tocar; no es fusiona. Fora d'abast: la
  prova nativa de mètodes d'entrada (execució N4) i altres idiomes de dreta a
  esquerra que no són al catàleg. Disseny: [docs/design/right-to-left.md](../design/right-to-left.md).

## Decisió

- **Què decideix la direcció:** l'idioma de la interfície. `applyDocumentLanguage`
  posa `lang` i `dir` a `<html>` (`dir="rtl"` per a l'àrab) en arrencar,
  des de la memòria cau de l'última sessió, i cada vegada que canvia l'idioma;
  tornar a un idioma d'esquerra a dreta restaura `dir="ltr"` sense recarregar.
  La llista d'idiomes de dreta a esquerra és fixa a `lib/direction.ts`, no
  una consulta a `Intl.Locale`: WebKitGTK i Bun no exposen tots aquesta
  informació i la mateixa resposta a tot arreu val més.
- **Propietats lògiques, no costats:** marges, farciments, posicions, vores,
  cantonades i alineació fan servir les utilitats lògiques de Tailwind 4.3
  (`ms/me`, `ps/pe`, `start/end`, `border-s/e`, `rounded-s/e/ss/se/es/ee`,
  `text-start/end`) i les propietats lògiques de CSS
  (`margin-inline-start`, `inset-inline-end`, `float: inline-start`…). No
  cal cap dependència nova. On no hi ha forma lògica (una
  ombra interior, un desplaçament amb `translate-x`), la regla de
  dreta a esquerra va al costat amb la variant `rtl:` o amb
  `[dir='rtl']`.
- **Un guardià a les proves:** `lib/physicalDirection.ts` cerca classes i
  estils amb costat físic en tots els components i a `App.tsx`; la prova
  falla amb cadascun de nou. Llegeix els valors arbitraris sencers
  (`ml-(--gap)`, `pl-[clamp(1px,2px,3px)]`) i se salta els comentaris,
  també els de JSX. S'accepten sense entrada a la llista: una classe
  aparellada a la mateixa línia amb la seva contrapart `rtl:`/`ltr:`, i el
  centrat `left-1/2 -translate-x-1/2`, que cau al mateix lloc en les dues
  direccions. La llista d'excepcions, cadascuna amb el seu motiu:
  - les nanses de les cantonades d'una imatge al redactor: els seus noms
    diuen «a dalt a l'esquerra» i l'arrossegament es calcula en píxels de
    pantalla;
  - l'estil en línia de la citació del correu que surt, una regla per
    direcció: els clients de correu (Outlook entre ells) no admeten
    propietats lògiques.

  No mira (es revisen a mà): les coordenades i transformacions en objectes
  `style` (`left`, `right`, `float`, `translateX`: les posicions preses del
  punter o d'un rectangle són físiques per naturalesa), ni `src/lib` ni
  `index.css`.
- **Icones:** es reflecteixen les que apunten al llarg de la línia (fletxes
  d'enrere i endavant, xebrons, respondre, reenviar, desfer, enviar, la
  citació d'una resposta, les subfinestres laterals, les llistes i l'ajust de
  línia). No es reflecteixen les de mitjans, les marques, les fletxes d'ordre
  (amunt i avall) ni els logotips. Un xebró girat amb `rotate-*` ja apunta en
  vertical i no es reflecteix; `no-mirror` exclou una icona. Un xebró de
  desplegar que gira en obrir-se es gira 180° en lloc de reflectir-se, perquè
  l'animació sigui un quart de volta i no un parpelleig. Una sola regla a
  `index.css` per nom de classe de Lucide, no un canvi a cada ús. Les
  fletxes escrites com a text («→», «←») surten de `forwardArrow` i
  `backArrow`, que les inverteixen en dreta a esquerra.
- **Teclat en el sentit de lectura:**
  - als separadors de subfinestres (ja ho feia `PaneResizer`, ADR-0059), a
    les pestanyes (proveïdors de compte, llistes de tasques) i als grups
    d'opció (tipus de calendari, color de categoria), les fletxes laterals
    segueixen la lectura: en àrab la fletxa esquerra va al següent. Inici i
    Fi van als extrems; les pestanyes i els grups es recorren en cercle.
    Si el focus encara no era en cap element, la fletxa només el porta al
    primer, sense triar-lo;
  - al visor d'imatges, la fletxa esquerra passa a la següent en
    àrab, com els botons, que també es reflecteixen;
  - les llistes i els menús verticals no canvien: amunt i avall no tenen
    costat;
  - les pestanyes continuen sent totes accessibles amb Tab, com abans (una
    prova d'arrencada ho exigeix); les fletxes s'afegeixen, no substitueixen.
- **Menús i finestres emergents:** el punt d'ancoratge d'un menú és la seva
  vora d'inici. `FloatingContextMenu` l'obre cap a la dreta en esquerra a
  dreta i cap a l'esquerra en dreta a esquerra, sempre dins de la
  finestra. El mesura a la vora esquerra de la finestra abans de col·locar-lo
  (un menú mesurat al costat de la vora dreta s'estreny i parteix les seves
  etiquetes) i el torna a col·locar quan canvia d'amplada (una fila que
  arriba després). Els botons passen la vora que correspon (`startEdgeX`,
  `endAlignedX`, `besideEndX`, `flyoutX`); els submenús s'obren passada la
  vora final de la seva fila, o passada la inicial si no hi caben. La subfinestra
  de detalls en superposició entra des de la vora final. Els avisos (toasts)
  estan centrats i no canvien.
- **El contingut de les persones conserva la seva direcció:**
  - assumptes, noms, adreces, etiquetes, títols d'esdeveniments i tasques,
    noms de carpeta i de fitxer porten `dir="auto"` (o `<bdi>` quan el
    text va dins d'una línia amb text de la interfície): el navegador els
    ordena per les seves pròpies lletres i no reordenen el que els envolta. A
    la targeta de la llista, la línia de l'assumpte pren la direcció de
    l'assumpte sol, no de la marca «Esborrany» que va davant;
  - s'alineen amb la interfície, no amb si mateixos (`text-align: match-parent`
    per a `[dir="auto"]`, sense especificitat, de manera que una classe
    d'alineació explícita continua manant). Un assumpte llatí a la llista
    àrab queda a la dreta, però es llegeix i es talla (amb «…») pel seu propi
    final;
  - les llistes de noms en una frase («per a Ana, Marc») aïllen cada nom
    (marques FSI/PDI) i en àrab se separen amb la coma àrab «،». Una llista
    d'esquerra a dreta en una interfície d'esquerra a dreta surt igual
    que abans;
  - el text que algú ha escrit i que es llegeix o s'escriu en diverses línies
    (cossos en text pla, el redactor en text i en format, la resposta
    ràpida, el xat, les notes d'esdeveniments i contactes, les traduccions i
    reescriptures proposades, els adjunts de text) pren la direcció de cada
    paràgraf (`unicode-bidi: plaintext`) i s'hi alinea. Els camps
    buits segueixen la interfície (`dir` només quan hi ha text: un camp buit
    amb `dir="auto"` es quedaria d'esquerra a dreta). El codi, els
    registres, els scripts de regles i les peticions exactes a l'assistent
    són sempre d'esquerra a dreta (`dir="ltr"`);
  - un missatge HTML que declara el seu `dir` es respecta. En un que no
    declara res, cada bloc de text (paràgraf, element de llista, títol,
    citació, i les cel·les i `div` amb text propi) rep `dir="auto"`; el
    `<body>` mai: un butlletí d'esquerra a dreta el primer text del qual és
    àrab (sovint un preencapçalament ocult) conserva les seves taules de
    maquetació d'esquerra a dreta, i un missatge que barreja paràgrafs llegeix
    cadascun en la seva direcció;
  - **el correu que surt declara la direcció dels seus blocs de dreta a
    esquerra:** en desar i en enviar, cada paràgraf, títol, llista o citació
    el primer caràcter fort del qual és de dreta a esquerra porta `dir="rtl"`,
    i una citació així porta la barra a la dreta (`border-right`,
    `padding-right`). Un paràgraf d'esquerra a dreta dins d'una llista o
    citació marcada porta `dir="ltr"`. El correu escrit d'esquerra a dreta
    surt byte a byte com abans (una prova ho comprova), i el que ja
    declara la seva direcció (un original citat) no es toca. Així una resposta
    en àrab sobre una citació en anglès arriba a Outlook, Apple Mail o Gmail
    amb cada part en la seva direcció.
  - **què és un caràcter fort de dreta a esquerra** (`firstStrongDirection`,
    per al correu que surt i la línia de l'assumpte): una lletra d'una
    escriptura de dreta a esquerra (hebreu, àrab, siríac, thaana, n'ko,
    samarità, mandeu i els blocs de dreta a esquerra dels plans
    suplementaris) o les marques RLM i ALM; qualsevol altra lletra, o LRM, és
    d'esquerra a dreta. Els dígits, els signes combinants, la puntuació, la
    marca d'ordre de bytes i els unidors no compten, com a `dir="auto"`. Amb
    un rang de punts de codi no n'hi ha prou: entre les escriptures àrabs i
    hebrees hi ha escriptures índiques i tailandeses que són d'esquerra a
    dreta.
- **Accessibilitat trobada per les proves en àrab**, defectes que ja hi eren
  en tots els idiomes i que es corregeixen, encara que canvien el que es veu
  en tots ells:
  - contrast per sota de 4,5:1 amb el tema clar per opacitats sobre
    `text-secondary`: les metadades de les files de missatge (data,
    destinataris), la capçalera de la conversa, els títols de grup de
    la llista de calendaris i de la navegació de Paràmetres. Es treuen
    aquestes opacitats (el text secundari continua sent-ho per color i pes);
  - els desplegables de Paràmetres no tenien nom accessible: prenen el títol
    de la seva fila;
  - dos contenidors de Paràmetres (la signatura i Actualitzacions) tenien
    `aria-label` sense rol: passen a ser `role="group"`.

## Alternatives descartades

- **Fusionar #198:** es va tallar d'un `main` antic (anterior a l'agenda de
  la barra lateral, els separadors, la impressió i la presència del xat) i
  no tenia proves.
- **Un plugin de PostCSS que inverteixi el full d'estils (rtlcss):** una
  dependència nova i un segon full per mantenir, quan Tailwind ja
  té utilitats lògiques.
- **`Intl.Locale().textInfo` per saber la direcció:** no és en tots els
  motors en què s'executa l'aplicació.
- **`dir="auto"` a cada bloc del correu que surt (opció `textDirection`
  de Tiptap):** canviaria l'HTML de tots els missatges enviats, en tots
  els idiomes, i els esborranys desats. Es declara només la direcció de
  dreta a esquerra, que és la que un client no suposa.
- **`dir="auto"` al `<body>` del missatge rebut** (la primera versió
  d'aquesta decisió): girava butlletins sencers per un preencapçalament àrab.
- **`Intl.ListFormat` per unir noms:** en «unit» canvia el separador
  d'altres idiomes («A y B» en castellà, cap en xinès); es fa servir la coma
  de l'idioma i res més.
- **Alinear el text de les persones amb si mateix:** una llista àrab amb
  uns assumptes a la dreta i d'altres a l'esquerra es llegeix pitjor;
  l'alineació segueix la interfície i la direcció, el text.
- **Pestanyes amb tabulació itinerant (només l'activa amb Tab):** és el
  patró WAI-ARIA, però canvia l'ordre de Tab que ja fan servir les persones i
  les proves d'arrencada; les fletxes s'afegeixen sense treure res.

## Pendent

- Prova nativa a Windows amb mètode d'entrada àrab (execució N4 final):
  SET-27 no passa a «verified» sense ella.
- Canviar a mà la direcció d'un paràgraf al redactor (Ctrl+Maj+
  dreta/esquerra, com Word o Outlook): fora de #226, en la seva pròpia incidència.
- Arrossegar columnes del tauler (dnd-kit) en dreta a esquerra: l'ordre
  es calcula amb rectangles reals i el teclat mou en el sentit de la
  fletxa, però falta comprovar-ho a l'aplicació nativa.
- Les línies que barregen text de la interfície i de les persones fora de les
  revisades aquí es revisaran amb la prova nativa.
