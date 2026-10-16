# Integració de lectura de Graph (#128)

Implementació additiva de l'ADR-0004 acceptat, a continuació de #125/#127. Servei global
d'escriptori, només la bústia de la sessió iniciada. Cap conversió automàtica d'IMAP/EWS.

## Activació i capacitats

- L'assistent de comptes ofereix una opció explícita **Microsoft Graph — read-only**; la
  detecció del domini mai no la tria implícitament. La configuració d'Outlook existent
  manté IMAP/SMTP. La reconnexió de Graph manté el compte seleccionat i el principal
  fixat.
- Després de l'autorització al backend, inicieu un job d'activació cancel·lable. Llegiu
  la jerarquia completa de carpetes visibles i completeu la ronda delta inicial de la
  safata d'entrada abans de publicar un compte nou `engine=mail`,
  `auth_type=graph_oauth`. Informeu del progrés/dels errors mentre s'espera; l'autorització
  per si sola no vol dir que estigui a punt.
- Un compte existent que no és de Graph amb la mateixa adreça normalitzada és una
  col·lisió, no un permís per convertir-lo. No en sobreescriviu mai les metadades, les
  concessions ni la memòria cau. Tornar a intentar l'activació de Graph pot reprendre el
  seu propi estat de lectura per etapes durador.
- Les metadades de perfil de Graph pendents són separades dels comptes actius. La
  cancel·lació o la sortida del procés no les publica; un intent explícit posterior pot
  reprendre-les. La cancel·lació/supressió invalida la generació abans que el treball
  tardà pugui confirmar-se.
- Els comptes de Graph actius admeten lectures de carpetes, converses i cossos de la
  memòria cau/fora de línia. Que la safata d'entrada estigui a punt no vol dir que totes
  les altres carpetes estiguin sincronitzades; obrir/sincronitzar una carpeta completa la
  seva pròpia ronda delta independent.
- L'estat de lectura, les marques, moure, copiar dins del compte i suprimir estan
  disponibles un cop el lector permet els canvis i Microsoft concedeix `Mail.ReadWrite`;
  vegeu [design/graph-message-actions.md](design/graph-message-actions.md) (#141).
  Els adjunts i les imatges inserides es llegeixen mitjançant MIME; vegeu
  [design/graph-attachments.md](design/graph-attachments.md) (#142).
  L'enviament està disponible un cop el lector el permet i Microsoft concedeix
  `Mail.Send`; vegeu [design/graph-sending.md](design/graph-sending.md) (#143).
  Els esborranys remots, l'enviament programat, la gestió de carpetes, els calendaris,
  els contactes, les bústies compartides i els núvols nacionals continuen sense ser
  compatibles. Desactiveu-ne els elements de la interfície i rebutgeu-ne les ordres del
  backend abans de qualsevol mutació, SMTP, IMAP o alternativa delegada. Es conserven les
  etiquetes locals i els esborranys locals existents; la lectura no marca com a llegit el
  correu remot. Les assignacions d'etiquetes locals continuen disponibles; la vinculació
  d'etiquetes remotes està bloquejada. Això inclou els camins de teclat/en bloc, els menús
  d'esborranys i la creació de carpetes; l'arrossegament al kanban segueix el permís de
  canvis. Una cancel·lació fallida de l'assistent conserva el seu identificador per a un
  reintent explícit.

## Identitat i projecció de carpetes

- Els ID de carpeta/element de Graph continuen sent valors opacs, que distingeixen
  majúscules i minúscules i qualificats pel compte. Taules de Graph separades els fan
  correspondre als localitzadors de memòria cau existents. No analitzeu ni feu el hash
  mai d'un ID d'element per convertir-lo en un UID ni reutilitzeu la correspondència
  d'EWS. Assigneu substituts locals `u32` duradors de manera monòtona per compte; no
  reutilitzeu mai les correspondències marcades com a eliminades (tombstone).
- Resoleu les carpetes d'ús especial mitjançant els àlies coneguts de Graph, no pels noms
  visibles traduïts. La safata d'entrada fa servir l'àlies de memòria cau `INBOX`
  existent; les altres carpetes fan servir un localitzador d'ID codificat estable. El nom
  visible i la relació amb el pare són metadades separades, de manera que reanomenar o
  canviar de pare no altera les referències desades de la memòria cau/del kanban.
- Recorreu les pàgines arrel i les pàgines de cada fill visible. Detecteu cicles, enllaços
  repetits, pares incoherents i ID en conflicte. Els límits fiten el treball per pàgina,
  no la mida de bústia informada: no el trunqueu per considerar-lo després un arbre complet. En aquesta
  slice no se sol·liciten les carpetes ocultes/exclusives del sistema.
- Persistiu de manera atòmica el llistat de carpetes complet i correcte. Un recorregut
  fallit deixa intacte el llistat anterior. Només les pertinences de memòria cau
  propietat de Graph es poden retirar quan la seva carpeta no apareix en un llistat de
  substitució complet.
- La identitat del missatge es fa correspondre independentment de la seva pertinença a
  una carpeta. Els moviments entre carpetes conserven el substitut local i la clau de
  conversa de Graph. Les marques d'eliminació (tombstones) d'abast de carpeta només
  eliminen aquella pertinença, no les còpies/etiquetes locals no relacionades. Les
  carpetes físiques validen els ID de pare retornats; les vistes de carpetes de cerca
  poden fer referència a la seva carpeta física subjacent.

## Durabilitat delta i transaccions de memòria cau

- Mantingueu les dades de missatges/el punt de control actius separats d'una ronda per
  etapes duradora. Cada pàgina acceptada i la seva continuació validada es registren al
  diari de manera atòmica. Un reinici/reintent reprèn les etapes; mai no promou una ronda
  incompleta.
- Les etapes fusionen els camps dispersos amb els seus valors anteriors. Els camps que
  falten són desconeguts, no buits/falsos. Per a un element dispers abans desconegut,
  recupereu-ne la representació completa abans de la projecció. Els elements/pàgines no
  vàlids fan fallar tota la pàgina.
- Només un punt de control delta final permet que una transacció actualitzi els registres
  d'elements de Graph, les pertinences, la memòria cau de missatges/cossos existent,
  l'estat de sincronització i el punt de control. Refactoritzeu l'upsert compartit de
  sobres perquè accepti una transacció propietat del qui crida, tot conservant el seu
  embolcall de transacció públic existent per als que criden des d'IMAP/EWS.
- El lector fa servir el sanejament/CSP i els formats de fil existents. Els ID de conversa
  de Graph fan servir un espai de noms codificat explícit, no heurístiques d'assumpte.
  Conserveu el JSON/l'estat local propietat de l'usuari en actualitzar les metadades
  remotes; les matrius de destinataris buides explícites continuen esborrant els
  destinataris remots obsolets.
- Una continuació 410/caducada només descarta les etapes i inicia un estat explícit de
  resincronització completa. Conserveu la memòria cau visible fins que aquesta ronda
  completa acabi; després elimineu només les seves pertinences de Graph que falten. No es
  barregen recorreguts antics i nous. Els errors de limitació i d'autenticació conserven
  les etapes i retornen una fallada tipada/un retard de reintent; cap reintent cec
  immediat ni cap espera de reintent bloquejant.
- Serialitzeu el treball de Graph per compte i comproveu la cancel·lació abans de la
  persistència. Fiteu cada operació de xarxa; el temps d'espera d'un que crida asíncron no
  pot autoritzar una tasca bloquejant separada a publicar una activació/un compte
  cancel·lat.
- La supressió del compte elimina els perfils/correspondències/etapes de Graph dins de la
  transacció de supressió del compte existent, després que la neteja de credencials de
  #127 tingui èxit. Els comptes i les concessions IMAP/EWS ordinaris fan servir els seus
  camins existents sense canvis.

## Porta de validació

Fixtures de proveïdor/magatzem/SQLite: jerarquia completa i interrompuda, noms duplicats,
reanomenament/canvi de pare, ID opacs, pàgines/deltes dispersos/marques d'eliminació,
moviments, reversió atòmica, recuperació de 410, reinici/cancel·lació, col·lisió/aïllament
de comptes, conservació d'esborranys/etiquetes locals, sanejament d'HTML i proteccions
d'operacions no compatibles.
Les proves del frontend d'entrada de producció cobreixen l'opció de Graph, el progrés de
l'autorització/l'activació, error/reintent/cancel·lació, el compte de només lectura i la
regressió de la configuració antiga.
Les revisions de lògica/de negoci i els set jobs de CI del head exacte precedeixen el
commit de fusió.
Les fixtures no estableixen la interoperabilitat amb un arrendatari real ni amb Windows
natiu; aquestes i els artefactes instal·lables del SHA exacte continuen sent evidència
d'acceptació separada.

Textos de la interfície: anglès i castellà; les cadenes noves de Graph fan servir l'anglès
com a alternativa en els altres catàlegs canònics. Això no és una paritat de localització
completa.

Fonts consultades el 2026-09-09: [carpetes](https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0),
[delta de missatges](https://learn.microsoft.com/en-us/graph/delta-query-messages).
