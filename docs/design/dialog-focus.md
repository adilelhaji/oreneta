# Cicle de vida del focus dels diàlegs compartits (#158)

Part de #37. L'estructura compartida `Dialog` ara posa el focus a la secció amb
nom quan s'obre, tret que un fill ja hagi obtingut el focus automàtic explícit.
Cada instància té un identificador de títol únic, fins i tot quan dos diàlegs
tenen títols idèntics.

En tancar-se, el focus torna a l'element que l'ha obert, si encara és connectat i
habilitat i si el diàleg encara tenia el focus. No pren el focus d'una superfície
més recent ni el posa en activadors eliminats, ocults o inerts, o inhabilitats.
Quan l'element que l'ha obert ha desaparegut, no es tria cap acció no relacionada
com a substituta. La restauració no desplaça la pàgina.

Un diàleg ocupat continua registrat a la pila existent d'Escapada: consumeix la
tecla sense tancar-se ni tancar un diàleg pare de sota. El botó de tancar i el
fons conserven les restriccions existents en estat ocupat.

Les proves unitàries cobreixen el focus inicial, el focus automàtic, els noms
duplicats, el tancament i l'Escapada, els activadors eliminats o inhabilitats,
la repetició d'efectes de StrictMode, una altra superfície que té el focus i un
diàleg ocupat imbricat. La prova de navegador de l'entrada de producció recorre
l'exemple del catàleg amb Tab, Espai, Retorn i Escapada i verifica el retorn del
focus després de tancar-lo amb el teclat i amb el punter.

Aquest és un increment del cicle de vida, no una afirmació d'accessibilitat modal
completa. La contenció del focus amb Tab, els menús en portal, les estructures de
diàleg personalitzades, l'ordre de capes simultànies i l'evidència amb lectors
de pantalla natius continuen a #37. Aquest canvi no introdueix cap captura del
focus ni cap gestor modal nou.
