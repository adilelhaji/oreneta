# Controls i retroacció compartits

Lliurament: [#152](https://github.com/adilelhaji/oreneta/issues/152), una part
acotada de [#33](https://github.com/adilelhaji/oreneta/issues/33). Fa servir la
[direcció d'art](art-direction.md), els testimonis de tema i el pont natiu existents.

## Comportament lliurat

- Els botons fan servir text `on-accent` llegible i colors semàntics de perill.
  En passar-hi per sobre canvia el color sense escalat ni resplendor; els
  controls desactivats continuen inerts.
- Les icones compartides fan servir 14/16/20px amb un traç d'1,75. Les icones
  decoratives s'oculten a les tecnologies d'assistència. L'escala tipogràfica
  inclou els graons d'encapçalament de 18/22/28px.
- Els camps no vàlids exposen `aria-invalid` i conserven l'anell de focus global
  del teclat.
- Un xip que es pot seleccionar i treure té dos botons germans. Treure'l amb el
  teclat o amb el punter no el pot seleccionar alhora; qui el crida ha de
  proporcionar una etiqueta per a l'acció de treure.
- Les etiquetes dels menús, els botons i els avisos ajusten el text llarg. Els
  estats buit, de càrrega i d'error comparteixen una disposició discreta i
  conserven rols diferenciats i accions explícites per tornar-ho a provar.
- **Obre el catàleg de disseny**, a la paleta d'ordres, mostra aquests estats, inclosos
  els controls desactivats, text llarg en castellà i un enllaç operatiu a la
  direcció d'art.

## Proves i límits

`design-primitives.test.tsx` cobreix les accions desactivades, les descripcions
dels camps d'entrada, la semàntica dels xips, els rols de retroacció i les accions
del catàleg. La bateria de navegador sobre el punt d'entrada de producció cobreix
clar i fosc a 1440px i 600px, el focus del teclat, el moviment reduït, la selecció
i la supressió, les etiquetes llargues i l'enllaç a la documentació. Desa captures
de pantalla dels controls i de la retroacció a l'artefacte de proves d'arrencada
de la CI.

Aquestes proves de navegador fan servir un pont natiu sintètic estricte. No
certifiquen proveïdors reals, el comportament natiu de WebView, tots els temes ni
l'accessibilitat completa. L'acceptació més àmplia de #33/#37 continua oberta: els
colors i les icones específics de pantalla que queden, el confinament i la
restauració del focus en les finestres modals, el zoom natiu i les comprovacions
amb tecnologies d'assistència encara necessiten les seves pròpies proves. Aquest
canvi de codi font no substitueix cap executable ni cap instal·lador.

[#177](screen-consistency.md) estén els testimonis, l'escala d'icones i els efectes
continguts als punts d'ús de l'aplicació i millora les pantalles secundàries
estretes. L'acceptació nativa i de fluxos de treball complets continua sent a part.
