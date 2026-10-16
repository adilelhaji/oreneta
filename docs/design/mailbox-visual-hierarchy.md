# Jerarquia visual de la taula de la bústia (#186)

Petit refinament visual dins de #34, que manté l'estructura aprovada i les
visualitzacions desades.

- Una capçalera fixa amb un ombrejat suau separa els controls de les columnes
  dels missatges.
- Les files tenen una alçada mínima de 36px; el remitent, l'assumpte i la data
  conserven l'escala tipogràfica i les columnes existents. El contingut llarg
  encara es trunca, amb indicadors de funció que mostren el text complet.
- Els assumptes no llegits tenen un punt del color d'èmfasi i el text en negreta.
  L'espai del punt es manté en els missatges llegits perquè els assumptes
  quedin alineats; l'etiqueta accessible de no llegit no canvia.
- Una vora interior de 3px a l'inici de la fila oberta continua visible al costat
  de la selecció múltiple. Segueix la fila, no una columna configurable concreta.
- Les files no llegides tenen un tint subtil. Els fons de fila oberta i de
  selecció múltiple tenen prioritat; la casella de selecció, la vora, el punt i
  el contorn del focus del teclat continuen sent senyals separats.
- Els colors compartits del tema admeten els temes desats, inclòs el mode fosc.
  No canvia cap preferència, ni l'estat de la bústia, l'ordenació, la selecció,
  el protocol o el comportament dels comptes.
- En el mode de colors forçats, unes vores amb colors del sistema conserven la
  vora de la fila oberta i el punt de no llegit quan se suprimeixen els tints de
  fons i les ombres.

Verificació: transicions d'estat dels components i escenaris de navegador sobre
el punt d'entrada de producció, en clar i en fosc, a l'amplada d'escriptori i a
amplades estretes, amb obertura i selecció amb el teclat, reordenació de columnes
i captures de pantalla renderitzades. Aquests escenaris sintètics no certifiquen
el zoom natiu ni els proveïdors reals i no substitueixen l'executable instal·lat.
