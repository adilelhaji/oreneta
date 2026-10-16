# Obertura i selecció a la taula de la bústia per defecte

Lliurament [#154](https://github.com/adilelhaji/oreneta/issues/154), part de #34.
Conserva l'estructura aprovada de l'aplicació, les columnes ordenables, les
preferències de taula o targetes desades i els contractes existents de les
operacions en bloc.

- Cada fila de la taula d'escriptori té una casella de selecció nativa. Un clic o
  la tecla d'espai la selecciona sense obrir ni llegir la conversa. L'assumpte és
  un botó de teclat separat.
- Obrir un assumpte buida la selecció múltiple i l'obre amb el mateix
  comportament d'esborrany, de canal destacat i de pestanya activa que les
  targetes. Ctrl/Ordre-clic commuta una fila; Maj-clic selecciona explícitament
  l'interval mostrat en aquell moment a partir de l'àncora.
- L'estat de selecció existent conserva les identitats exactes seleccionades. Els
  missatges que arriben no s'hi afegeixen automàticament. L'opció Selecciona-ho tot
  de la barra d'eines existent actua sobre les files carregades en aquell moment;
  no selecciona resultats de cerca que no s'han vist ni crea cap regla de selecció
  contínua. Mentre hi ha un conjunt seleccionat, els menús contextuals individuals
  se suprimeixen, igual que a les targetes existents, perquè el recompte de la
  barra d'eines no es pugui confondre amb una acció d'una sola fila.
- Una línia d'èmfasi a l'esquerra identifica la conversa oberta, el text en
  negreta identifica el correu no llegit, les caselles i el tint identifiquen la
  selecció múltiple, i el contorn del focus identifica l'objectiu del teclat.
  Aquests estats poden coexistir. Les files conserven la semàntica de taula.
  El [refinament de la jerarquia visual](mailbox-visual-hierarchy.md) hi afegeix
  un punt de no llegit amb espai reservat, un ritme de files de 36px i mou la vora
  de la fila oberta a l'inici de la fila, també quan es reordenen les columnes.
- La taula compacta dona 80px a les dates i el 27% al remitent; el text de
  l'assumpte ocupa la resta. El text de previsualització ja no competeix amb
  l'assumpte a la mateixa línia. Els indicadors de funció de l'assumpte i del
  remitent conserven el text complet, amb com a màxim una etiqueta visible i el
  recompte de les etiquetes restants. Les icones fan servir els colors del tema i
  l'escala compartida.

`baseline/tableSelection.test.tsx` verifica la selecció, les arribades, els
intervals, l'abast del menú contextual, l'obertura mentre
se selecciona, la sortida de la pestanya de redacció, els esborranys i els canals
destacats. Les proves de navegador sobre el punt d'entrada de producció exerciten
la selecció i l'obertura amb el teclat en cobalt clar i fosc a 1440px i
720px (l'amplada CSS existent equivalent a un zoom d'escriptori del 200%), i desen
captures de pantalla. La bateria de límits existent encara comprova la navegació
del lector i de l'editor de missatges al voltant de 769px i 1024px. Els escenaris
de navegador són sintètics, no són una certificació nativa ni amb proveïdors.

#34 continua oberta per al poliment més ampli de la llista de targetes, les proves
de zoom natiu i d'accessibilitat, la presentació del progrés i dels resultats
parcials de les operacions en bloc i el desfer verificat. La configuració de les
columnes continua a #36. Aquest canvi no substitueix cap executable ni publica cap
versió.
