# Magatzem d'esborranys locals (#169)

Contracte d'implementació sota l'[ADR-0010](../adr/0010-full-profile-local-recovery.md).
Aquest lliurament prepara el magatzem; la connexió a l'editor, la migració de
localStorage, les imatges inserides i les respostes ràpides corresponen a #170.
Encara no lliura la recuperació de l'editor ni una còpia completa.

## Document i confirmació

Un identificador local opac i estable identifica l'esborrany, independentment del
seu Message-ID remot. Un document JSON versió 1 conserva la identitat, el compte,
els destinataris, l'assumpte, els cossos i els adjunts amb els seus bytes en
base64 i les metadades. Els camps addicionals es conserven. Un adjunt no se
substitueix pel seu camí temporal. Les referències a imatges de la memòria cau
requereixen capturar-ne els bytes a #170 abans de declarar l'esborrany complet
per a una còpia.

La base de dades existent emmagatzema el document i la revisió junts en una
transacció. Fa servir el xifratge de la base de dades existent; el mode de proves
sense clauer continua sent sintètic. La confirmació es retorna després del
commit, amb la sincronització SQLite FULL per a aquesta escriptura. Un error de
validació, de quota, d'espai o d'escriptura no substitueix el document previ. Un
resultat incert s'ha de tornar a llegir; no es reintenta amb una revisió
endevinada. Les proves de procés no certifiquen una fallada elèctrica física.

## Concurrència i cicle de vida

Crear exigeix la revisió esperada 0. Actualitzar o descartar exigeix la revisió
llegida; el commit incrementa la revisió i en retorna el valor. Un conflicte
retorna la revisió vigent i si s'ha descartat, sense sobreescriure ni crear
còpies ocultes. El client conserva els seus canvis fins que es resol
explícitament (#170).

Descartar buida el document i manté una làpida (tombstone): ni una creació ni
una actualització tardana poden ressuscitar aquell identificador. En aquest
lliurament no s'esporguen les làpides. Descartar un identificador encara no desat
també crea una làpida per bloquejar-ne la primera escriptura tardana. Cada
esborrany nou fa servir un identificador nou.

El canvi de compte es desa juntament amb el contingut mitjançant la mateixa
revisió; no copia l'esborrany entre comptes. Eliminar un compte no elimina
l'esborrany local: es conserva per recuperar-ne el contingut, sense autoritzar
l'enviament des d'una identitat absent. Un enviament pendent, fallit o incert no
descarta res automàticament. El llistat pot filtrar per compte; llegir i
modificar requereixen l'identificador local complet. Cap operació no toca
proveïdors, la xarxa ni les cues d'enviament.

## Límits i lectura

Identificador: 1–128 caràcters ASCII alfanumèrics, guionet o guió baix. Document
serialitzat: fins a 64 MiB; cossos HTML i de text: fins a 8 MiB cadascun; camps
de capçalera: fins a 64 KiB; fins a 64 adjunts i 40 MiB de bytes adjunts en
conjunt. Es validen el base64 i la mida declarada exacta, els identificadors
d'adjunt únics, i el MIME i el nom limitats. Màxim 256 esborranys actius; les
làpides no compten com a actives. No es trunca ni s'elimina automàticament
contingut per complir aquests límits. El transport del nucli admet respostes de
fins a 65 MiB per al document de 64 MiB i el seu embolcall. Un error de lectura o
un excés del límit rebutja explícitament les sol·licituds pendents, sense
registrar el contingut rebut. També invalida el transport i n'atura el procés;
les sol·licituds següents fallen sense escriure. Cal reiniciar l'aplicació per
obrir un altre nucli.

Els llistats només retornen identificador/compte/revisió/data, no tots els
bytes. Llegir retorna un document validat o un error explícit; les dades
corruptes i les versions futures no es converteixen mai silenciosament en un
esborrany buit. #170 ha de mostrar els errors i els conflictes, conservar la
còpia antiga fins que es confirmi la migració i aturar la captura completa si hi
ha escriptures sense confirmar.

## Validació requerida

Migració idempotent sense pèrdua; reobertura de text, identitat i adjunts;
conflictes entre connexions; descart davant de la primera escriptura tardana;
canvi o absència de compte; límits, format futur, corrupció; reversió
(rollback) davant d'un error i base de dades de només lectura. Revisió tècnica i
de producte i CI del commit exacte. L'activació a l'editor és a
[editor-draft-recovery.md](editor-draft-recovery.md) (#170); l'acceptació nativa
continua pendent.
