# Edició de contactes: decisions pendents (#41)

Estat: **proposta**. #41 demana aprovar aquestes decisions abans d'escriure
codi. Fins aleshores no hi ha cap escriptura de contactes.

## Què existeix avui

- **Fonts de només lectura.** CardDAV (`meron-core/src/carddav`), Google People
  amb el permís `contacts.readonly` i contactes d'Exchange.
- **Model.** `people` desa l'origen de cada contacte (`source`, `account`,
  `book`, `uid`), però no la seva versió: no hi ha cap columna d'ETag ni
  d'`etag` de Google ni de `ChangeKey` d'Exchange. Sense versió, una escriptura
  no pot detectar un canvi d'altri.
- **#28** ja garanteix que una sincronització incompleta no suprimeix contactes.

## Decisions

### 1. Quines fonts es poden editar

Proposta, per ordre:
1. **Una llibreta local** («en aquest equip»), sense servidor. És el primer pas
   perquè no depèn de res extern.
2. **CardDAV.** Escriptura amb `PUT` i `If-Match`, i alta amb
   `If-None-Match: *`. Radicale ja és a la CI per provar-ho (N3).
3. **Google**, només després de la decisió 2.
4. **Exchange**, només amb evidència d'un servidor real (la mateixa regla que
   el calendari).

Els directoris i les llibretes que el servidor marca com a de només lectura no
ofereixen mai edició. A CardDAV això es llegeix de
`current-user-privilege-set`.

### 2. Permís de Google

Editar contactes exigeix canviar `contacts.readonly` per `contacts`. Aquest
permís és sensible en la verificació de Google i afecta la decisió pendent de
#144 sobre registres OAuth propis. Proposta: no demanar-lo fins que hi hagi el
registre propi, i demanar-lo a part, només quan algú editi un contacte de
Google (com `Mail.ReadWrite` a Graph, #141).

### 3. Conflictes

Proposta: desar la versió de cada contacte (ETag, `etag` o `ChangeKey`) i
escriure sempre amb aquesta versió. Si el servidor respon que ha canviat (412),
no es desa res, es rellegeix el contacte i es mostren les dues versions perquè
la persona triï. No es fusiona ni se sobreescriu mai en silenci.

### 4. Supressió

Proposta:
- suprimir al servidor només després d'una confirmació, anomenant la llibreta;
- sense paperera local en el primer lliurament;
- un contacte que el servidor ja no té es tracta com a suprimit, no com a
  error.

### 5. Duplicats

#41 exigeix que enllaçar duplicats sigui revisable i no suprimeixi res remot.
Proposta: un enllaç local entre contactes, mostrat com una sola persona i que es
pot desfer, sense escriure res al servidor.

### 6. Importar i exportar vCard

Proposta:
- **Importar** només a la llibreta local o a una de CardDAV editable, amb
  previsualització i límit de mida, i descartant les targetes sense nom ni
  correu (`Person::is_useful`).
- **Exportar** el que es veu, amb l'origen en un camp `X-` de la targeta.

### 7. Fotos

Avui la foto viatja amb la targeta. Proposta:
- no baixar mai fotos per URL remot, perquè farien de píxel de seguiment;
- conservar només les fotos incrustades, amb un límit de mida;
- en exportar, incloure la foto només si es demana.

## Ordre proposat després de l'aprovació

1. Migració: columna de versió a `people`, emplenada a la sincronització
   següent.
2. Llibreta local amb alta, edició i supressió (N1/N2).
3. CardDAV amb ETag contra Radicale: conflicte, permís revocat, targeta mal
   formada i interrupció (N3).
4. Duplicats i vCard.
5. Google i Exchange, quan se'n compleixin les condicions.
