# Regions de l'aplicació i F6 (#306)

Pas 1 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §6 i §9): regions
amb nom i F6 entre elles, sense cap canvi visual. Els passos següents (la
subfinestra de carpetes, la banda superior i el selector de mòduls) canvien el
que hi ha a cada regió, no aquest mecanisme.

Codi: `frontend/src/lib/regions.ts`, `states/ui.ts` (`ui$.module`), `App.tsx`,
`components/dialog/AppHotkeys.tsx`, `lib/shortcuts.ts`,
`components/chat/HtmlFrame.tsx`, `components/sidenav/SideNav.tsx`,
`components/banner/UpdateBanner.tsx` i els `data-region` de les vistes de cada
mòdul.

## Un sol estat de mòdul

- `ui$.module` (`mail`, `calendar`, `people`, `tasks`, `notes`, `chat`,
  `attachments`) substitueix els sis booleans d'abans (`calendarOpen`,
  `peopleOpen`…). Dos mòduls no poden estar oberts alhora, i ja no cal que cada
  botó posi els altres a fals.
- És estat de la interfície, no dades desades: l'aplicació arrenca al correu.
- `toggleModule` és el que fa cada botó de la barra vertical: obre el mòdul o,
  si ja és obert, torna al correu.

## Regions

| Regió | Element | Nom accessible | `data-region` |
|---|---|---|---|
| Barra vertical | `<aside>` | «Mòduls» | `modules` |
| Subfinestra de carpetes del correu (`FolderPane`, des de #317) | `<nav>` | el de la seva fila de títol: «Comptes i carpetes» | `folders` |
| Subfinestra de carpetes del Calendari (`FolderPane`, des de #323); per sota de 1025 px, la columna d'abans | `<nav>` | «Calendaris» | `folders` |
| Subfinestra de carpetes de Persones (`FolderPane`, des de #326): els grups; per sota de 1025 px, el filtre de grups d'abans, sota la capçalera de la llista | `<nav>` | «Grups de contactes» | `folders` |
| Subfinestra de carpetes de Tasques (`FolderPane`, des de #329): les llistes; per sota de 1025 px, les pestanyes d'abans, sota la capçalera | `<nav>` | «Llistes de tasques» | `folders` |
| Subfinestra de carpetes de Notes (`FolderPane`, des de #335): les etiquetes; per sota de 1025 px, els botons d'etiqueta d'abans, sobre la llista de notes | `<nav>` | «Etiquetes de notes» | `folders` |
| Subfinestra de carpetes de Xat (`FolderPane`, des de #337): les converses; per sota de 1025 px, la columna d'abans | `<nav>` | «Converses» | `folders` |
| Mòdul | `<main>` | el del mòdul: «Correu», «Calendari», «Persones», «Tasques», «Notes», «Xat», «Adjunts» | — |
| Llista de converses o tauler; als altres mòduls, el mòdul sencer | la d'avui | — | `content` |
| Lector | `[data-message-pane]` | — | `reader` |
| Barra lateral de detalls | `<aside>` | — | `sidebar` |

- Hi ha un sol `<main>`. Els diàlegs de l'aplicació, els avisos (toasts), les
  confirmacions i l'avís de certificat en surten i es pinten al costat de les
  regions.
- Els diàlegs que obre un mòdul (l'editor d'una persona, l'editor i el detall
  d'un esdeveniment, la revisió del context de l'assistent, la galeria
  d'imatges) es pinten dins d'aquest mòdul i són modals (`aria-modal="true"`).
  L'editor i el detall d'un esdeveniment, la revisió de l'assistent i la galeria
  no ho eren. Ara són `ModalCard` (`components/dialog/ModalCard.tsx`), sense cap
  canvi visual: `role="dialog"`, `aria-modal` i nom; en obrir-se prenen el focus
  (si no el té ja un control de dins) i en tancar-se el tornen a l'element que
  els havia obert, com el `Dialog` compartit.
- Amb un diàleg modal obert tampoc no actuen les dreceres de les posicions de la
  barra vertical (Ctrl/⌘+1…9 o la tecla que s'hi hagi assignat).
- La barra vertical i la subfinestra de carpetes continuen dins de `<main>`
  fins que el selector de mòduls substitueixi la barra (pas 4): la barra es
  pinta abans que les carpetes, a la mateixa fila. Al pas 2 (#317) la
  subfinestra de carpetes comuna va substituir «Comptes i carpetes» al correu,
  amb el mateix nom i la mateixa regió, i a partir de 1025 px també la columna
  de calendaris del Calendari (#323), els grups de Persones (#326), les llistes
  de Tasques (#329), les etiquetes de Notes (#335) i les converses de Xat
  (#337). Les proves que hi arriben amb `main > aside` canvien al pas 4
  (ADR-0068 §8), quan la barra passa a ser el `<nav>` «Mòduls» d'ADR-0068 §1.
- La barra vertical té nom perquè no hi hagi dues regions complementàries sense
  nom quan la barra lateral de detalls és oberta.
- Fins al pas 2, la columna de Notes té el mateix nom que `<main>` («Notes»).
  Són de rols diferents i axe no ho marca, però ADR-0068 §1 no ho permet: el pas
  2 li dona el nom «Etiquetes». La del Calendari, que es deia «Calendari» com
  `<main>`, es diu «Calendaris» des de #323. La de Persones no era cap punt de
  referència (una `<section>` sense nom, només la regió `folders`): la
  subfinestra de #326 es diu «Grups de contactes», diferent de `<main>`
  («Persones») i de «Grups» en tots els catàlegs, per decisió del propietari.
  Tasques no tenia cap regió «carpetes» (les pestanyes eren dins del mòdul): la
  subfinestra de #329 es diu «Llistes de tasques», diferent de `<main>`
  («Tasques») en els 20 catàlegs, per decisió del propietari. A Notes, la
  columna de la llista, que es deia «Notes» com `<main>`, ja no és la regió
  «carpetes» a partir de 1025 px: ho és la subfinestra de #335, que es diu
  «Etiquetes de notes» (`notes.tagsPane`), diferent de `<main>` («Notes») i de
  la resta de noms de regió en els 20 catàlegs, com comprova una prova. Per sota
  de 1025 px la columna conserva la regió i el nom d'abans. A Xat passa el mateix:
  la columna de converses, que ja es deia «Converses» (`messaging.conversations`),
  és la subfinestra de #337 a partir de 1025 px i conserva el nom, que és
  diferent de `<main>` («Xat») i de la resta de noms de regió i de llista de Xat
  («Grups», «Converses directes», «Invitacions») en els 20 catàlegs, com comprova
  una prova; per sota de 1025 px és la columna d'abans.
- L'avís d'actualització és una regió que té per nom el mateix text de l'avís,
  perquè no quedi contingut fora de cap regió. Encara no té cap prova
  automàtica: les proves arrenquen sense cap actualització disponible.

## F6 i Maj+F6

- **Ordre:** cerca de la banda, barra d'eines, carpetes, mòduls, llista o
  contingut, lector i barra lateral (`REGION_ORDER`). Avui no hi ha ni banda ni
  barra d'eines. Al correu, doncs, l'ordre és aquest: carpetes, barra vertical,
  llista, lector i barra lateral. La barra vertical es pinta abans que les carpetes,
  però F6 hi arriba després: és l'ordre del marc nou, on els mòduls són al peu
  de les carpetes (pas 4), i així no canvia d'un pas a l'altre. ADR-0068 §6 diu
  que és l'ordre del document: al marc nou tots dos coincideixen, i mentre la
  barra vertical es pinti abans que les carpetes, mana la llista de l'ADR.
- **Cicle:** després de l'última regió, F6 torna a la primera. Des de fora de
  qualsevol regió, F6 va a la primera i Maj+F6, a l'última.
- **Se salten** les regions que no es veuen (perquè l'amplada les amaga o perquè
  són `inert`, `aria-hidden` o `hidden`) i les que no tenen res que pugui rebre
  el focus.
- **Dins d'una regió,** el focus torna a l'últim element que el tenia, si encara
  el pot rebre; si no, va al primer element al qual s'arriba amb Tab. Una regió
  dins d'una altra (la columna esquerra dins del mòdul) és una regió a part: els
  seus elements no compten per a la de fora.
- **Dreta a esquerra:** el mateix ordre, que no depèn del costat de la finestra.
- **Mentre s'escriu:** les dreceres «nues» (d'una sola tecla, sense Ctrl/⌘ ni
  Alt) no actuen dins d'un camp de text; és la barrera d'`isBareShortcut`.
  F1–F12 no escriuen text i en queden fora, de manera que F6 també funciona des
  d'un camp de text. Si algú reassigna F6 a una lletra, torna a valer la barrera
  i dins d'un camp s'escriu la lletra.
- **Qualsevol drecera en una tecla de funció:** val el mateix per a totes, no
  només per a F6 (per exemple, F9 per sincronitzar, de l'esquema Outlook, ara
  també actua dins d'un camp de text), però amb un diàleg modal obert no actuen,
  com abans.
- **Des del missatge HTML:** el marc aïllat reenvia F1–F12, a més de les
  dreceres amb Ctrl/⌘ o Alt i de les fletxes.
- **Diàleg modal obert** (`aria-modal="true"`): F6 no fa res i el diàleg reté el
  focus.
- **Catàleg:** `pane.next` i `pane.prev`, al diàleg *Dreceres de teclat*, grup
  «View», es poden reassignar. Els noms dels grups i de les dreceres encara no
  són al catàleg de traduccions, com abans d'aquest pas.
- **Pendent (N4):** encara no s'ha comprovat que F6 arribi a la pàgina a
  WebView2 i a WebKitGTK. Fins aleshores la documentació d'usuari no promet F6
  (ADR-0068 §6).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`lib/regions.test.ts`) | L'ordre del marc i, dins d'un mateix tipus, el del document; un tipus desconegut falla; les regions amagades, inertes o sense res que pugui rebre el focus se salten; un element que no accepta el focus no compta; el cicle d'anada i tornada; el focus torna a l'últim element; una regió dins d'una altra; un diàleg modal |
| N2 (`components/dialog/AppHotkeys.test.tsx`) | F6 des d'un camp de text, amb la tecla consumida; res amb un diàleg modal d'un mòdul ni amb Configuració oberta; la paleta d'ordres es queda les tecles; reassignada a una lletra, s'escriu dins d'un camp; reassignada a F8, actua mentre s'escriu i no amb un diàleg modal; una posició de la barra vertical assignada a una tecla de funció no actua amb un diàleg modal d'un mòdul |
| N2 (`components/dialog/ModalCard.test.tsx`) | Diàleg modal amb nom; pren el focus de l'element que l'obre i l'hi torna en tancar-se; respecta el focus que un control de dins ja ha pres |
| N1 (`lib/shortcuts.test.ts`) | F6 i Maj+F6 per defecte, sense col·lisions; F1–F12 no són nues; reassignar F6 a una lletra torna a posar la barrera |
| N2 (`HtmlFrame.test.tsx`) | El marc reenvia F1–F12, amb Maj o sense, i no una lletra |
| N1 (`states/uiModule.test.ts`) | Els set mòduls; el botó de la barra vertical obre el mòdul i, si ja és obert, torna al correu; mai dos mòduls alhora |
| N2 (proves dels mòduls) | `ui$.module` en lloc dels sis booleans |
| e2e (`startup.e2e.ts`, «#306») | A 1440 px, en anglès, català i àrab: un sol `<main>` amb el nom del mòdul, la barra vertical «Mòduls» i F6 / Maj+F6 en el mateix ordre, fins a tornar a la fila de la llista. Des d'un camp de text, des del missatge HTML i amb un diàleg modal obert; un avís emergent (toast) i el diàleg fora de `<main>`. Al calendari, a Persones, a Tasques, a Notes i a Xat, F6 va del mòdul a la seva columna (des de #323, #326, #329, #335 i #337, a la subfinestra de carpetes) i torna a la barra vertical. Una reassignació a una lletra. A 600 px, només les regions que es veuen; al 200 % de l'aplicació, el mateix ordre sense desplaçament horitzontal. Les regles de regions d'axe (`region`, `landmark-unique`, `landmark-one-main`) no troben res a la bústia ni a cap mòdul |

Les proves de límits, de zoom, de dreta a esquerra i les auditories axe que ja
hi havia no canvien: aquest pas no mou res de lloc.
