# Càrrega i paginació de la bústia

## R4.1 (#63)

Les files i els cursors pertanyen a una clau de compte/carpeta/consulta/filtre/ordenació.
Només una vista coincident pot carregar una altra pàgina. Canviar qualsevol camp rebutja
les respostes antigues fins i tot abans que s'executi l'efecte de recàrrega de React. Una
actualització de la primera pàgina invalida la paginació en curs; una càrrega en segon pla
no pot fusionar files d'una altra vista.

Cada sol·licitud `mail.threadList` repeteix el paràmetre `sort` existent. Un canvi
d'ordenació torna a carregar la primera pàgina mitjançant l'efecte normal de la bústia (la
cerca conserva el seu temps d'espera antirebot existent). La cerca de memòria cau a dades
en directe també comprova l'ordenació abans d'avançar. La interfície buida/de càrrega fa
servir la mateixa clau completa que el carregador. Les pàgines posteriors d'un sol compte
conserven l'ordre del backend i eliminen duplicats per identitat de fil, incloses les
identitats duplicades dins d'una mateixa resposta.

La codificació del cursor, la base de dades i les capacitats d'ordenació admeses no
canvien. Són garanties de transport/estat, no una certificació d'ordenació d'extrem a
extrem.

Validació: 21 de les 25 regressions d'estat inicials fallaven a `cde6e1f` abans de la
correcció. La bateria final afegeix 29 proves d'estat i 5 proves de React renderitzades,
que cobreixen els clics a la capçalera, els sis paràmetres d'ordenació, les sol·licituds
obsoletes, el reintent, l'antirebot, el desmuntatge, l'ajornament del tauler i l'estat
buit/de càrrega. A Windows/Bun 1.4.2 la bateria completa del frontend va superar 831
proves; la comprovació de tipus i els 24 casos de referència de Chromium es van superar.
La CI torna a executar la bateria per al commit de lliurament; les simulacions del
navegador no certifiquen l'ordenació dels proveïdors.

## R4.2 (#65)

Els cursors de text nous porten la clau d'ordenació SQL exacta, i conserven els espais en
blanc i la semàntica d'equivalència de majúscules i minúscules de la base de dades; vegeu
[paginació amb clau de text](text-page-cursors.md).
La codificació del cursor i les capacitats d'ordenació admeses no canvien.

## R4.3 (#67): primitiva de cursor compartida

L'[ADR 0003](adr/0003-conversation-pagination.md) recull el contracte de substitució
aprovat. #67 només introdueix la seva primitiva compartida d'ordenació/cursor; les rutes
existents continuen fent servir el comportament de R4.1/R4.2 fins que es migrin els seus
adaptadors.

## R4.4 (#69): preparació de l'adaptador de memòria cau

El servei de memòria cau compartit llegeix capçaleres de carpeta lleugeres en blocs de
1.024 missatges mitjançant la consulta keyset de missatges existent, sense cap límit de
files totals. Agrupa la carpeta completa de la memòria cau, conserva les targetes amb un
missatge coincident i fa servir el `(date, UID)` coincident més recent per al remitent/la
data mostrats. Els assumptes arrel canònics i els ID de branca provenen de la carpeta
completa, no dels resultats filtrats. Els agregats de no llegits/destacats cobreixen la
targeta de carpeta de la memòria cau; els recomptes de missatges conserven l'eliminació existent de
duplicats entre carpetes amb l'abast del lector. Les claus de targeta/arrel
posposades s'exclouen abans de la paginació. No es recupera cap cos ni canvia cap marca de
vist.

Una única transacció de lectura de SQLite cobreix l'obtenció de candidats, la paginació i
l'enriquiment. El que crida proporciona els àmbits de correu resolts i l'espai de noms
d'origen; els àmbits es canonicalitzen/se n'eliminen els duplicats i totes les targetes
elegibles comparteixen un únic límit global. La cerca, els només destacats, els posposats i
l'RSS no són entrades d'aquest servei exclusiu de Recent. Només les targetes seleccionades
reben l'enriquiment de metadades, agrupades per compte/carpeta.

Cost: cada resposta recorre el conjunt de capçaleres de la memòria cau (i un segon conjunt
filtrat per a les vistes per facetes), conserva metadades O(headers + cards) i ordena
O(cards log cards). Les consultes existents de resolució del nom visible continuen
aplicant-se. Això afavoreix la correcció sense una projecció persistent; no és una
afirmació de temps constant per a bústies grans.
Les rutes i els clients no s'activen amb #69; el treball posterior ha de gestionar la substitució per
actualització, els errors de cursor, les respostes obsoletes i la preservació de l'ordre
del backend.

## R4.5 (#71): salvaguardes per al mòbil

R4.5 (#71) prepara el mòbil: els errors de la llista de fils es propaguen en lloc de
convertir-se en pàgines buides; les sol·licituds porten explícitament l'ordenació per data
per defecte (l'ordre compartida també accepta altres ordenacions, sense afegir cap control
a la interfície). Les addicions conserven l'ordre del nucli i eliminen els ID duplicats.
Una vista/generació/cursor capturat rebutja la paginació obsoleta després d'una navegació o
una actualització. L'error explícit de recàrrega del cursor de conversa desencadena una
càrrega de substitució sense cursor per a la mateixa vista actual; les fallades ordinàries
conserven el cursor per al reintent. Es conserva la substitució per actualització
existent que té en compte la profunditat. Això no activa les rutes noves del nucli.

## R4.6 (#73): activació del correu

El correu Recent agrupat fa servir el servei de converses compartit a l'escriptori i al
mòbil, inclosos els rols unificats els àmbits resolts dels quals només contenen
comptes de correu.
La resposta declara `pagination: "conversation-v1"` fins i tot a les pàgines finals/buides.
La resolució de rols, el límit global i les metadades de la resposta són compartits.
Es conserva la preparació existent d'adjunts/prioritat; només les sol·licituds de la
primera pàgina inicien la sincronització en segon pla. Els que criden amb missatges en brut
conserven els cursors de missatge. Un cursor `conv1:` enviat a un origen no migrat es
rebutja, mai no s'interpreta com una primera pàgina.

El context del cursor vincula el RecentFilter **efectiu**, no una cadena de facetes en brut
reordenada: l'analitzador antic selecciona la primera faceta d'etiqueta, de manera que
invertir facetes d'etiqueta en conflicte ha d'invalidar la continuació. L'etiqueta opcional
es codifica de manera segura.

L'escriptori transmet la profunditat de pàgina a través del pont de Go (per defecte 50).
Les actualitzacions de converses substitueixen alhora les files i la continuació, i
sol·liciten la profunditat carregada per a les actualitzacions en segon pla. Mai no
fusionen un prefix nou sobre un cursor antic ni tornen a ordenar per data els resultats
unificats. El resum d'un lector obert es pot conservar per separat de les files llistades;
no s'ha d'injectar al resultat ordenat. Els errors explícits de recàrrega del cursor
desencadenen una substitució sense cursor, i els errors obsolets no poden tornar a carregar
una altra vista. Les fallades normals de sol·licitud conserven l'estat de reintent.

La cerca, els només destacats, els posposats, l'RSS i les vistes unificades mixtes de
correu/RSS conserven els seus contractes d'origen existents. Aquesta migració no certifica
les seves capçaleres genèriques d'ordenació de taula ni afegeix un contracte d'instantània
de proveïdor/cerca. No implica cap versió publicada.

## Treball pendent de #30

- Recent unificat (només correu) fa servir la paginació compartida de converses de la
  memòria cau i ja no depèn de l'ordenació per data de la fusió en ventall antiga.
- El frontend aplica la mateixa protecció d'identitat per primera aparició a les pàgines
  inicials i incrementals, i conserva l'ordre del backend quan un proveïdor repeteix una
  fila en un límit de pàgina. Les actualitzacions de converses de la mateixa vista
  sol·liciten la profunditat carregada, substitueixen el prefix de manera atòmica i
  mantenen un únic cursor per al nou prefix ordenat; la cobertura de regressions inclou
  arribades noves i ID duplicats.
- La cerca i els destacats mantenen contractes basats en la data; els posposats fan servir
  l'ordre de despertada i l'RSS té el seu propi llistat. Les vistes unificades
  mixtes/independents de l'origen continuen sent antigues tret que segueixin l'abast del
  treball posterior de #30.
- Les capçaleres genèriques de taula no certifiquen l'ordenació a escala de tot el
  proveïdor.
- La selecció conservada, les fusions en segon pla de la mateixa vista, les insercions
  incrementals i les claus de targetes agrupades encara requereixen validació de
  l'ordenació.

No tanqueu #30 fins que s'hagin provat aquests contractes i el recorregut d'un conjunt de
dades estable. Les arribades noves poden canviar una bústia en directe; aquesta slice no
introdueix cap instantània ni garanteix un ordre globalment complet sobre missatges encara
no recuperats.
