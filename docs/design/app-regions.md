# Regions de l'aplicació i F6 (#306)

Pas 1 de l'ordre de migració
d'[ADR-0068](../adr/0068-marc-comu-de-l-aplicacio.md) (§1, §6 i §9): regions
amb nom i F6 entre elles, sense cap canvi visual. Els passos següents (la
subfinestra de carpetes, la banda superior i el selector de mòduls) canvien el
que hi ha a cada regió, no aquest mecanisme.

Codi: `frontend/src/lib/regions.ts`, `states/ui.ts` (`ui$.module`), `App.tsx`,
`components/dialog/AppHotkeys.tsx`, `lib/shortcuts.ts` i
`components/chat/HtmlFrame.tsx`.

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
| Comptes i carpetes (correu) | `<nav>` | «Comptes i carpetes» | `folders` |
| Columna esquerra de Calendari, Persones, Notes i Xat | la d'avui | la d'avui | `folders` |
| Mòdul | `<main>` | el del mòdul: «Correu», «Calendari», «Persones», «Tasques», «Notes», «Xat», «Adjunts» | — |
| Llista de converses o tauler; als altres mòduls, el mòdul sencer | la d'avui | — | `content` |
| Lector | `[data-message-pane]` | — | `reader` |
| Barra lateral de detalls | `<aside>` | — | `sidebar` |

- Hi ha un sol `<main>`. Els diàlegs de l'aplicació, els avisos (toasts), les
  confirmacions i l'avís de certificat en surten i es pinten al costat de les
  regions.
- Els diàlegs que obre un mòdul (l'editor d'una persona, el d'un esdeveniment)
  es pinten dins d'aquest mòdul i són modals (`aria-modal="true"`).
- La barra vertical i «Comptes i carpetes» continuen dins de `<main>` fins que
  la subfinestra de carpetes i el selector de mòduls les substitueixin (passos
  2 i 4). Les proves que hi arriben amb `main > aside` canvien al pas 4
  (ADR-0068 §8).
- La barra vertical té nom perquè no hi hagi dues regions complementàries sense
  nom quan la barra lateral de detalls és oberta.
- L'avís d'actualització és una regió que té per nom el mateix text de l'avís,
  perquè no quedi contingut fora de cap regió.

## F6 i Maj+F6

- **Ordre:** cerca de la banda, barra d'eines, carpetes, mòduls, llista o
  contingut, lector i barra lateral (`REGION_ORDER`). Avui no hi ha ni banda ni
  barra d'eines. Al correu, doncs, l'ordre és aquest: carpetes, barra vertical,
  llista, lector i barra lateral. La barra vertical es pinta abans que les carpetes,
  però F6 hi arriba després: és l'ordre del marc nou, on els mòduls són al peu
  de les carpetes (pas 4), i així no canvia d'un pas a l'altre.
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
- **Des del missatge HTML:** el marc aïllat reenvia F1–F12, a més de les
  dreceres amb Ctrl/⌘ o Alt i de les fletxes.
- **Diàleg modal obert** (`aria-modal="true"`): F6 no fa res i el diàleg reté el
  focus.
- **Catàleg:** `pane.next` i `pane.prev`, a *Dreceres de teclat → Visualització*,
  es poden reassignar.
- **Pendent (N4):** encara no s'ha comprovat que F6 arribi a la pàgina a
  WebView2 i a WebKitGTK. Fins aleshores la documentació d'usuari no promet F6
  (ADR-0068 §6).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`lib/regions.test.ts`) | L'ordre del marc i, dins d'un mateix tipus, el del document; un tipus desconegut falla; les regions amagades, inertes o sense res que pugui rebre el focus se salten; el cicle d'anada i tornada; el focus torna a l'últim element; una regió dins d'una altra; un diàleg modal |
| N1 (`lib/shortcuts.test.ts`) | F6 i Maj+F6 per defecte, sense col·lisions; F1–F12 no són nues; reassignar F6 a una lletra torna a posar la barrera |
| N2 (`HtmlFrame.test.tsx`) | El marc reenvia F1–F12, amb Maj o sense, i no una lletra |
| N1 (`states/uiModule.test.ts`) | Els set mòduls; el botó de la barra vertical obre el mòdul i, si ja és obert, torna al correu; mai dos mòduls alhora |
| N2 (proves dels mòduls) | `ui$.module` en lloc dels sis booleans |
| e2e (`startup.e2e.ts`, «#306») | A 1440 px, en anglès, català i àrab: un sol `<main>` amb el nom del mòdul, la barra vertical «Mòduls» i F6 / Maj+F6 en el mateix ordre, fins a tornar a la fila de la llista. Des d'un camp de text, des del missatge HTML i amb un diàleg modal obert; l'avís i el diàleg fora de `<main>`. Una reassignació a una lletra. A 600 px, només les regions que es veuen; al 200 % de l'aplicació, el mateix ordre sense desplaçament horitzontal. Les regles de regions d'axe (`region`, `landmark-unique`, `landmark-one-main`) no troben res a la bústia ni a cap mòdul |

Les proves de límits, de zoom, de dreta a esquerra i les auditories axe que ja
hi havia no canvien: aquest pas no mou res de lloc.
