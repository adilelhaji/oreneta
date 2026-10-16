# Columnes generals i per carpeta (#160)

Implementa l'ADR 0009, acceptat. A la visualització de taula, **Columnes** obre un
editor d'esborrany: es tria Visualització general o Només aquesta carpeta, es
commuta la visibilitat, es mouen les columnes amb botons amb nom d'amunt i avall, i
s'introdueixen amplades de 64 a 640 píxels CSS. L'assumpte continua visible i pot
fer servir l'amplada automàtica. Desa aplica l'esborrany; Tanca/Esc el descarta.
Restableix el valor per defecte substitueix l'esborrany pel valor predefinit
compacte i encara cal Desa. Fes servir la visualització general elimina
immediatament l'excepció d'aquella carpeta.

La visualització general l'hereten tots els parells de compte i carpeta que no
tenen una substitució. Una substitució és una instantània independent.
Actualitzar la disposició general no la sobreescriu. Els ID són parells exactes,
inclosos el compte unificat i els rols existents; les etiquetes i els noms
visibles no són mai claus d'emmagatzematge. La cerca fa servir la disposició de
la carpeta actual, no cap altre espai de noms de substitucions.

Les preferències absents o no vàlides conserven la taula proporcional que ja
existia. La configuració explícita fa servir el valor predefinit compacte aprovat
(remitent de 120 px, assumpte automàtic, data de 80 px, compte ocult de 120 px).
Aquesta distinció preserva els usuaris existents fins al seu primer desament
explícit. Les disposicions no vàlides es rebutgen en bloc; les entrades de carpeta
no vàlides s'ignoren i guanya el primer duplicat vàlid. Les versions futures
desconegudes es conserven literalment durant la hidratació i els canvis no
relacionats; l'edició continua desactivada fins a un restabliment explícit de
totes les visualitzacions de columnes o una actualització de l'aplicació.

`mailbox_views` fa servir el camí existent de lectura i escriptura de
preferències i no escriu durant la hidratació. Només les capçaleres de remitent,
assumpte i data ordenen, a través de la preferència global existent d'ordenació
de tot el resultat. Compte mostra el nom o l'adreça del compte coneguts i no fa
veure que ordena. La selecció continua fora de les columnes configurables; el
marcador d'obert se situa a l'assumpte, que és obligatori, fins i tot quan el
remitent està ocult. Les disposicions massa grans es desplacen dins de la
finestra de la llista existent, de manera que la paginació i les capçaleres fixes
queden a la mateixa superfície de desplaçament.

Les proves inclouen els límits del validador i les versions mal formades o
futures; l'aïllament exacte per compte i carpeta i l'herència; la hidratació i la
persistència; la cancel·lació de l'esborrany, els errors d'amplada i l'associació
semàntica dels errors; l'estat de selecció i d'obert amb el remitent ocult; proves
de navegador sobre el punt d'entrada de producció per al teclat, la recàrrega, la
navegació entre carpetes, el restabliment de versions futures, clar i fosc,
600/1440 px i un zoom CSS del 200 %. Els escenaris de prova (fixtures) de navegador fan servir correu
sintètic i el contracte del pont existent; no certifiquen el reinici natiu de la
base de dades ni el comportament amb lectors de pantalla. El text nou és en
castellà i en anglès, amb l'anglès com a alternativa en els altres catàlegs a
l'espera de traducció. #36 conserva les capacitats de columnes que queden,
l'acceptació nativa i la localització completa; no s'inclou cap versió publicada.
