# ADR-0010: Còpia completa local xifrada d'un perfil

- Estat: acceptada.
- Data: 2026-10-05.
- Abast: #146, #113 i durabilitat d'esborranys de #39.
- Aprovació humana: «Sí, implementar copia completa local cifrada», en resposta
  a l'opció B de [la proposta](../design/profile-recovery-options.md), que
  inclou esborranys i fitxers.
- Substitueix exclusivament el límit de configuració del punt 2 de l'ADR-0008.
  Els diagnòstics locals i les actualitzacions confirmades mantenen el seu contracte.

## Decisió

Conservar l'exportació de configuració com a opció independent i afegir una
còpia manual local xifrada del perfil desat. Primer, fer durables els
esborranys complets i els seus fitxers. Una captura no es presenta com a completa
si hi ha dades pendents de desar, fitxers omesos o errors sense resoldre.

La captura coordina les escriptures de base i fitxers; no copia una base viva a
cegues. L'arxiu té format versionat, manifest i límits de mida i
camins. El seu xifratge és obligatori i reutilitza primitives existents. La contrasenya
no s'inclou a la còpia. La recuperació ha de funcionar amb l'arxiu i la contrasenya
sense el clauer original: la clau necessària per a obrir la base es distingeix de
les credencials i les claus privades opcionals. El manifest declara les seves exclusions.

La restauració es valida en una ubicació aïllada abans d'una activació
explícita i reversible. Una contrasenya incorrecta, una corrupció, una incompatibilitat,
una interrupció o la manca d'espai conserven el perfil original. El perfil recuperat
queda sense sincronització fins a una reconnexió i una reconciliació explícites. Mai
no es reenvien automàticament missatges, invitacions ni escriptures pendents o de
resultat incert.

Compatibilitat inicial amb Windows i amb formats/esquemes expressament admesos;
rebutjar formats futurs sense modificar la destinació. No implica portabilitat a
mòbil ni gestió simultània de diversos perfils. La programació i la retenció són
posteriors, desactivades per defecte, amb límits visibles i protecció de la
darrera còpia validada. No s'autoritzen núvol, publicació ni despesa addicional.

## Lliuraments i límits d'evidència

1. Durabilitat d'esborranys i fitxers: magatzem #169 i integració de l'editor
   i les respostes ràpides #170, amb revisió de concurrència i errors.
2. Captura consistent, xifratge i verificació de l'arxiu: #171.
3. Restauració aïllada, activació reversible i interrupcions: #172.
4. Programació i retenció explícites: #173.

Cada lliurament inclou proves, revisió tècnica i de producte, i CI del commit
lliurat. L'arxiu requereix espai addicional, i perdre'n la contrasenya impedeix
obrir-lo. Les proves sintètiques no acrediten la recuperació nativa ni la interoperació
amb proveïdors. #113 continua oberta fins que se'n demostri tota l'acceptació.
