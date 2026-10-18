# Menús accessibles (#289)

Peça 7 del redisseny aprovat pel propietari (decisió D9: files de 28 px). Tots els
menús emergents i contextuals de l'aplicació fan servir una sola primitiva pròpia,
a `frontend/src/components/menu/`. No s'hi afegeix cap dependència: el repositori
no té cap biblioteca de primitives accessibles.

## Peces

| Peça | Per a què |
|---|---|
| `FloatingContextMenu` | Menú situat en un punt (el punter o la cantonada d'un botó), en un portal. És el `role="menu"` mateix, amb nom (`label` o `labelledBy`). Amb `surface="popover"` és una targeta que conté un camp i un `MenuList` (el selector de carpetes). |
| `MenuList` | `role="menu"` per a un desplegable que es col·loca tot sol (enviar més tard, text desat, etiquetes, cerques desades, menús de barra). |
| `MenuItem` | Una fila: `menuitem`, o `menuitemcheckbox` / `menuitemradio` amb `checked`. |
| `SubmenuItem` | Fila que obre un submenú al costat («Mou a», «Copia a»). |
| `MenuGroup` | Elements sota un títol: el títol dona nom al grup (`aria-labelledby`) i una descripció opcional s'hi llegeix (per què una conversa és en una categoria). |
| `MenuSeparator` | `role="separator"`. |
| `lib/menuKeyboard.ts` | La lògica del teclat, pura i provada a part. |

Un menú només conté elements, grups i separadors. Un camp de cerca va al costat
del menú, no a dins; una nota (la d'enviar més tard) va fora i el menú la cita amb
`aria-describedby`. Els estats buits i de càrrega dins un submenú són elements
desactivats, perquè les fletxes també hi arribin.

## Teclat

- Amunt i Avall recorren els elements i tornen a començar pels extrems; Inici i Fi
  hi van directament. Els elements desactivats s'hi inclouen i s'anuncien
  (`aria-disabled`), però no fan res.
- Una lletra va al següent element que hi comença; la mateixa lletra repetida en
  recorre tots els que hi comencen, i unes quantes lletres seguides (en mig segon)
  busquen el text sencer.
- La fletxa cap al final de la línia (Dreta; Esquerra en àrab, ADR-0061), Retorn o
  Espai obren el submenú i hi posen el focus; la fletxa cap a l'inici el tanca i
  torna el focus a la fila que l'havia obert.
- Escapada tanca només el menú de més a dins (la pila compartida de
  `useEscapeKey`). Tab tanca tot el menú.
- Un menú de colors en fila (`orientation="horizontal"`) es mou amb les fletxes
  laterals, en l'ordre de lectura.
- Les tecles que el menú fa servir no arriben a cap altre lloc: ni a la navegació
  amb fletxes d'una llista que l'envolti ni a les dreceres d'una sola tecla.

## Focus

En obrir-se, el focus va al primer element, tret que un camp del menú ja l'hagi
agafat. En tancar-se, torna a l'element que el tenia abans, si el menú encara el
tenia, i mai el pren a una superfície que l'hagi agafat mentrestant ni el posa en
un element que ja no hi és, desactivat o ocult (les mateixes regles que
`useDialogFocus`). Un submenú obert passant-hi per sobre amb el punter no mou el
focus.

## Disseny

Files de 28 px (`min-h-7`) amb icona de 14 px al començament, xebró al final dels
submenús i drecera alineada al final; continuen per sobre dels 24 px de WCAG 2.5.8.
En passar-hi per sobre i amb el focus del teclat, fons de selecció; l'anell de focus
es dibuixa a dins de la fila. Una fila amb aspecte propi (la carpeta actual, el filtre
actiu) passa `appearance` en lloc de sumar classes que es contradiuen.

## Menús migrats

Menú contextual de la conversa (correu i canals, amb «Mou a» i «Copia a») i les seves
seccions de prioritat i categoria; menú contextual del missatge; «Més» de la barra
de selecció; accions de la llista de converses i de la columna del tauler; menú del
tauler; abast de la cerca del tauler; selector de carpetes; menús de la barra lateral
(compte, tauler, carpeta, safata unificada); menú ràpid «Més»; menú de l'esdeveniment;
selector de color del calendari; «Més accions» i menú del remitent del lector; menú
de la persona als detalls de la conversa; menú de la imatge a la galeria; remitent de
la resposta ràpida; etiquetes; cerques desades; enviar més tard; text desat; i la
mostra del catàleg de disseny.

## Proves i límits

`lib/menuKeyboard.test.ts` prova la lògica de cada tecla i de la cerca per lletra;
`components/menu/Menu.test.tsx`, la primitiva (rols, fletxes, cerca per lletra,
desactivats, submenús en els dos sentits, Escapada, Tab i retorn del focus). A
l'entrada de producció, `e2e/startup.e2e.ts` («#289») obre el menú contextual d'una
conversa i el seu submenú en anglès i en àrab, hi passa axe sense acceptar cap
infracció i els recorre amb el teclat; una altra prova obre un menú des del seu botó
amb el teclat.

Fora d'abast: les accions noves del menú del missatge (etiqueta, crear reunió, crear
regla, veure l'origen), que són una peça posterior; el menú principal de la banda
superior (peça 13); les barres d'eines i els botons dividits (peça 8); i les finestres
que no són menús (autocompletar destinataris, paleta d'ordres, suggeriments de
gramàtica). L'evidència amb lectors de pantalla natius i la nativa de Windows
continuen pendents (#37).
