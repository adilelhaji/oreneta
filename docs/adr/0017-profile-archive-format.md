# ADR-0017: Format de la còpia completa del perfil

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: decisions 1 a 5 de
  [la llista pendent](../design/full-profile-archive-decisions.md) per a
  l'ADR-0010 (#171, #172). La 6 (còpies programades, #173) queda per al seu
  lliurament.

## 1. Xifratge

Es descarten dues opcions:
- **Blocs AES-GCM propis.** Era la proposta inicial, però és una
  construcció nova que l'ADR-0010 prohibeix sense revisió criptogràfica.
- **Un límit de 512 MiB i una sola passada.** Deixa fora els perfils reals i
  exigeix tenir tot l'arxiu en memòria.

**Decisió:** el format [age](https://age-encryption.org/v1) amb
contrasenya, mitjançant el crate `age` 0.11.
- La clau es deriva amb scrypt i el contingut es xifra amb la construcció
  STREAM (ChaCha20-Poly1305 per blocs de 64 KiB, amb un indicador de
  darrer bloc).
- És un format publicat, revisat i amb implementacions independents.
  Escriu i llegeix en una passada, sense límit de mida, i detecta el
  truncament.
- Cost de scrypt: N = 2^18 en escriure, fix, perquè un arxiu fet en
  un equip ràpid s'obri en un de lent. En llegir s'accepta com a màxim
  N = 2^20, perquè el cost ve de l'arxiu abans de comprovar la
  contrasenya.
- La contrasenya té almenys 8 caràcters i no es desa enlloc.
- La dependència només es compila a l'escriptori.

## 2. Inventari

**Hi entra:**
- la base completa: correu en memòria cau i arxiu local, esborranys amb els seus
  adjunts, intents d'enviament, contactes, tasques, notes i paràmetres;
- les imatges triades per la persona: avatars i fons (`media/avatars`
  i `media/wallpapers`).

**No hi entra, i el manifest ho declara amb el motiu:**
- la memòria cau d'adjunts, que es torna a baixar;
- contrasenyes, concessions i claus privades, que viuen al clauer;
- la disposició de la finestra i les pestanyes obertes (els esborranys són
  a la base);
- el registre de diagnòstic.

Amb les exclusions declarades, la còpia s'anomena «completa del perfil» i la
interfície enumera el que en queda fora.

## 3. Secrets

No s'inclouen en aquesta versió. Després de restaurar, cada compte es torna a
connectar, com l'ADR-0010 ja exigeix abans de sincronitzar. Incloure'ls de manera
opcional queda per a una versió 2 del format, en una secció a part.

## 4. Clau de la base

- La base viatja exportada amb una clau aleatòria pròpia de l'arxiu,
  desada al manifest, dins del flux xifrat. Així, l'arxiu s'obre
  només amb la seva contrasenya, sense el clauer original.
- En restaurar, es torna a xifrar amb la clau de l'equip, de manera que el
  perfil restaurat no depèn de l'arxiu.

## 5. Contenidor i límits

- Extensió: `.oreneta-profile`.
- Dins del flux xifrat hi van, per aquest ordre:
  1. una línia màgica amb la versió;
  2. les entrades (nom, mida i bytes);
  3. el manifest, amb format, versió, data, versió de l'aplicació,
     esquema, clau de la base, entrades amb SHA-256 i exclusions;
  4. una marca de final.
- El manifest va al final per a calcular el resum (hash) de cada entrada en una
  sola passada.
- Límits:
  - 4 GiB per entrada i 200 000 entrades;
  - noms canònics de fins a 512 bytes, que només poden ser `db/meron.db`
    o estar sota `media/`;
  - no s'admeten `..`, `.`, separadors dobles, arrels, unitats ni barres
    inverses, ni noms repetits.
- Es rebutgen els arxius d'una versió o d'un esquema més nous.
- La base restaurada ha de passar `PRAGMA integrity_check`.
- La còpia s'escriu en un `.part` que es reanomena en acabar. La base
  només es bloqueja mentre es copia (`sqlcipher_export` en una sola
  sentència), no mentre s'empaqueta.

Falta la comprovació d'espai lliure, que depèn de la plataforma; es
mesura en la verificació nativa (N4).

## Conseqüències

- El format no s'inventa i la seva seguretat es basa en age. El que és propi és
  l'empaquetament interior, que es prova canviant byte a byte, amb talls,
  camins maliciosos, noms repetits, manifests falsos i versions
  futures.
- Una còpia ja escrita es pot comprovar sense tocar el perfil en ús.
