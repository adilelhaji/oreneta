# ADR 0003: Paginació de converses

Estat: Acceptada — 2026-09-08. Aprovació del mantenidor a la conversa de treball de #30.

## Decisió

L'escriptori i el mòbil compartiran un únic contracte de pàgina de converses al
nucli de Rust. Els missatges elegibles s'agrupen en targetes candidates
completes **abans** d'ordenar i limitar. Els identificadors de fil existents,
qualificats per compte/carpeta i que tenen en compte les branques per
assumpte, continuen sent la identitat de la fila. Aquesta decisió no autoritza
cap projecció persistent, migració d'esquema ni canvi de proveïdor.

Per al correu basat en la memòria cau, l'elegibilitat fa servir les facetes
existents de cada missatge. El representant és l'últim missatge coincident
segons `(date, UID)`, independentment del sentit de l'ordenació. La
normalització de destinataris de sortida i de noms visibles s'aplica abans
d'ordenar. Es preserven les regles existents d'identitat d'assumpte i branca
per arrel canònica i l'abast del lector; la paginació no ha de baixar cossos
ni marcar missatges com a llegits. L'adaptador ha de construir els agregats a
partir de l'abast complet de targetes de la memòria cau, no del fragment de
la pàgina.

S'ordena per data del representant, per remitent mostrat (nom o, si no n'hi
ha, adreça) o per assumpte mostrat. La comparació de text fa servir minúscules
ASCII, preservant els espais en blanc i els punts de codi no ASCII, d'acord
amb la convenció de minúscules existent de SQLite. L'identificador qualificat
de la targeta desfà els empats. El sentit s'aplica a totes dues claus. Les
visualitzacions unificades fan servir el mateix comparador i un únic límit
global, no un límit per compte.

El nou cursor de conjunt de claus opac `conv1:` porta un resum del context de
la visualització i la clau d'ordenació i l'identificador de l'última
conversa. El context inclou l'espai de noms d'origen, els abasts de
compte/carpeta resolts, la consulta retallada, el conjunt de facetes
normalitzat i l'ordenació canònica. L'ordre d'enumeració d'abasts i facetes
és irrellevant. La mida de pàgina pot canviar. Els cursors mal formats,
antics o d'un altre context fallen explícitament amb un error de tornar a
carregar la primera pàgina; mai no s'han de convertir en silenci en
respostes de primera pàgina afegides a files antigues. Els consumidors de
missatges en brut mantenen el contracte de cursor existent durant la
migració.

Aquest és un contracte de conjunt de claus en viu, no una captura de la
bústia. Els candidats sense canvis es recorren exactament una vegada. Les
insercions posteriors al cursor poden aparèixer en pàgines posteriors; les
anteriors requereixen actualitzar la primera pàgina. Moure una targeta
existent d'un costat a l'altre del cursor la pot ometre o repetir fins a
l'actualització. Els clients eliminen els identificadors duplicats i substitueixen el
recorregut carregat en actualitzar; no han d'empeltar files noves en cursors
antics. Els resultats del proveïdor que encara no són a la memòria cau queden
fora de les garanties de completesa basades en la memòria cau.

## Lliurament i restriccions

1. #67: primitiva compartida d'ordenació/cursor amb proves; sense canvis a les rutes actives.
2. Seguiment: obtenció de candidats basada en la memòria cau, adaptadors
   d'escriptori/mòbil, paginació global unificada i gestió d'actualitzacions/errors
   al client amb proves d'integració.
3. Conciliar per separat les captures de cerca, la desduplicació
   entre carpetes dels destacats, l'ordenació de despertada dels posposats i
   l'RSS abans d'activar-hi aquest contracte.

L'obtenció de candidats no ha d'imposar cap tall invisible pel nombre de
missatges. La integració inicial basada en la memòria cau pot escanejar
metadades lleugeres per blocs i conservar candidats agrupats; només
s'enriqueix la pàgina seleccionada. Cal deixar constància del cost d'escaneig
O(capçaleres en memòria cau) resultant i provar el recorregut de fils grans.
Un índex persistent o un contracte diferent de proveïdor/captura requereix
una decisió d'arquitectura separada. La incidència mare #30 continua en curs
fins que es compleixi l'acceptació d'extrem a extrem.

## Verificació

Cal provar les sis ordenacions, claus buides/repetides/Unicode, col·lisions
d'identitat qualificada, canvis de mida de pàgina, cursors no vàlids i d'una
altra visualització, el recorregut estable complet i els límits de mutació
indicats. Les proves dels adaptadors, a més, han de cobrir branques,
representants filtrats, reescriptura d'identitat, pertinença unificada,
agregats de fil complet i equivalència entre escriptori i mòbil. La CI
existent continua sent la porta de lliurament.
