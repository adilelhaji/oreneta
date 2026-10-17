# Llibreta de contactes local (#41, ADR-0012, pas 1)

## Què fa

- **Persones** té un botó «Contacte nou». Els contactes de la llibreta local
  tenen «Edita» i «Suprimeix». Els de llibretes sincronitzades (CardDAV, Google,
  Exchange) continuen sent de només lectura i no mostren aquests botons.
- Els contactes locals només es desen en aquest equip, i l'editor ho indica. No
  tenen compte, de manera que eliminar un compte no els afecta (ADR-0011).
- Un contacte necessita un nom o un correu. Les files buides no es desen, i els
  correus es desen en minúscules, igual que els sincronitzats.

## Versions i conflictes

- `people.version` (migració 37) desa la versió amb què es va llegir cada
  contacte. Per a la llibreta local és un comptador; per a CardDAV serà l'ETag
  (pas 2).
- Editar o suprimir exigeix la versió llegida. Si no coincideix, perquè una altra
  finestra l'ha canviat o suprimit, no s'escriu res i el nucli retorna la còpia
  actual.
- Aleshores l'editor mostra les dues versions. «Conserva la meva» desa sobre la
  versió actual. «Queda't amb la desada» descarta els canvis. Si el contacte
  s'ha suprimit, les opcions són «Torna'l a crear» o «Descarta».
- Suprimir des d'una versió antiga no suprimeix res i avisa.

## Ordres del pont

- `people.save {id?, version?, person}`: crea o edita. Respon
  `{ok, id, version}` o `{conflict: true, current}`. Una edició sense versió es
  rebutja.
- `people.delete {id, version}`: suprimeix. Respon el mateix.
- `people.list` afegeix `version` i `editable` a cada contacte.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 magatzem (`store/local_people/tests.rs`) | Alta i neteja de camps; edició que fa avançar la versió; edició des d'una versió antiga (no escriu i retorna la còpia actual); edició d'un contacte suprimit; supressió des d'una versió antiga; rebuig de contactes buits; un contacte sincronitzat no es pot escriure per aquesta via |
| N1 distribuïdor (`main.rs`) | Alta, llistat amb `editable`, conflicte entre dues finestres, edició sense versió i supressió |
| Go (`people_write_test.go`) | Sense el nucli en marxa, una escriptura falla en lloc de fingir que ha desat |
| N2 vista (`PersonEditor.test.tsx`) | Alta des de la capçalera; botons només en contactes editables; conflicte: es veuen les dues còpies i «Conserva la meva» desa sobre la versió actual; «Descarta» no escriu |

## Pas 2: llibretes CardDAV

### Què es pot fer

Els contactes d'una llibreta CardDAV es poden editar i suprimir, i en crear un
contacte es tria «Aquest equip» o una llibreta CardDAV editable. L'editor indica
on es desa el canvi. En suprimir un contacte de servidor, l'avís recorda que
desapareix per a totes les aplicacions que llegeixen aquella llibreta. Google
continua sent de només lectura (ADR-0012); les persones d'Exchange s'editen des
d'ADR-0066.

### Què desa la sincronització

- De cada targeta: el seu URL (`people.href`, migració 38) i el seu ETag
  (`people.version`).
- De cada llibreta: si el servidor hi permet escriure, segons
  `current-user-privilege-set` (`contact_sources.writable`). Si el servidor
  diu que no, no s'ofereix editar. Si no diu res, es permet editar i es mostra
  el rebuig del servidor, si n'hi ha.

### Com s'escriu

- **Editar.** Es llegeix la targeta actual. Si el seu ETag no és el que es va
  llegir, no s'escriu res i es retorna la còpia del servidor. Si coincideix, es
  modifica la targeta del servidor i s'envia amb `If-Match`. Un `412` entre la
  lectura i l'escriptura també és un conflicte.
- **Només canvien les línies tocades** (`contacts::vcard_write`). Es conserva
  tot el que l'aplicació no mostra: adreces, aniversaris, foto, UID, camps propis
  d'altres clients i l'etiqueta d'Apple que va amb cada correu.
  - Un correu o un telèfon que no canvia conserva la línia original.
  - En canviar el nom es reescriuen `FN` i `N`. `N` porta el nom sencer com a
    nom de pila, sense endevinar cognoms.
- **Crear.** S'envia una targeta vCard 3.0 nova amb `If-None-Match: *`. Si el
  servidor no retorna l'ETag, es torna a llegir la targeta.
- **Suprimir.** S'envia `DELETE` amb `If-Match`.
- **No s'escriu mai sense una versió coneguda** ni en un servidor diferent del
  de la llibreta: la contrasenya no en surt (#28).

### Correcció trobada pel camí

`ORG` es tallava en un `;` escapat: «Acme\; Ltd» es llegia «Acme». Ara només se
separa per `;` sense escapar, igual que `N`.

### Proves del pas 2

| Nivell | Què cobreix |
|---|---|
| N1 (`contacts/vcard_write_tests.rs`) | Una targeta d'Apple editada conserva ADR, BDAY, foto, UID i etiquetes; treure un correu en treu l'etiqueta; reanomenar; números amb un espaiat diferent; targeta nova d'anada i tornada; línies plegades sense partir caràcters |
| N1 (`carddav/write_tests.rs`, servidor fals amb estat) | `If-Match` correcte; conflicte sense escriptura; «Conserva la meva»; targeta suprimida al servidor; alta amb `If-None-Match` i ETag tornat a llegir; supressió des d'una versió antiga; no s'envia res a un altre servidor; no s'escriu mai sense versió |
| N1 (`carddav/client_tests.rs`) | Permisos: només lectura, `write`, `all` i sense resposta |
| N3 (`integration_contact_writes_test.go`, Radicale 3.5.4) | Editar conservant BDAY i ADR; canvi al servidor → conflicte sense escriptura, i «Conserva la meva» després; alta a la llibreta; supressió des d'una versió antiga rebutjada, i després correcta |
| N2 (`PersonEditor.test.tsx`) | Triar la llibreta en crear; editar un contacte de servidor amb la seva versió, indicant on es desa |

La prova N3 es va executar en local contra Radicale 3.5.4 instal·lat aquí, en
lloc de Docker. A la CI s'executa amb la imatge Docker de l'arnès.

## Pas 3: vCard i duplicats

### Importar i exportar vCard

- **Exportar** desa un `.vcf` amb tots els contactes o amb els que mostra la
  cerca. Cada targeta indica el seu origen a `X-ORENETA-SOURCE`. El fitxer
  s'escriu només per al propietari, com una còpia de seguretat.
- **Importar** es fa en dos passos:
  - primer, una previsualització: quants contactes hi ha, quins es deixen fora
    per no tenir ni nom ni correu, i una mostra de noms. No es desa res;
  - després s'importa a «Aquest equip» o a una llibreta CardDAV editable.
- **Regles de la importació:**
  - Un contacte ja present a la destinació (el mateix nom i el mateix primer
    correu) s'omet, de manera que importar dues vegades no duplica la
    llibreta.
  - El primer error atura la importació i s'informa de quants s'han arribat a
    importar.
  - Es rebutgen els fitxers de més de 20 MB i els que no són vCard.
- **Fotos:** avui no es desen, de manera que no s'exporten. Tampoc no es baixen
  mai fotos remotes.

### Duplicats

- L'aplicació suggereix contactes que comparteixen correu, en qualsevol
  llibreta. No els uneix mai pel seu compte.
- «La mateixa persona: enllaça» els mostra com un de sol a la llista. La fitxa
  mostra «Còpies enllaçades», amb cada origen i un botó «Desenllaça».
- «No és la mateixa» es recorda i no es torna a suggerir.
- Un enllaç és només local: no suprimeix, no fusiona i no escriu res en cap
  servidor.
- Sobreviu a la resincronització, perquè els identificadors són estables, i
  desapareix en suprimir el contacte o el seu compte.

### Proves del pas 3

| Nivell | Què cobreix |
|---|---|
| N1 | Exportació amb origen; previsualització (descarts, no vCard, mida); detecció de duplicats exactes; suggeriments, enllaç que sobreviu a la resincronització, desenllaç, «no és la mateixa», enllaç amb contactes inexistents |
| N1 distribuïdor | Previsualització sense desar res; importar dues vegades sense duplicar; exportar |
| N2 | Importació amb previsualització i confirmació; exportació del que es veu; suggerir, enllaçar, veure les còpies i desenllaçar |

## Següent

Google, quan se'n compleixin les condicions (ADR-0012, #144).
