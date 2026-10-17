# ADR-0016: Perfils aïllats

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #99.

## Inventari previ

Hi havia un únic joc de dades per instal·lació:
- la base xifrada i el registre a `<config>/oreneta`;
- la memòria cau d'adjunts a `<cache>/oreneta`;
- els secrets al clauer sota el servei `meron`, amb entrades per
  compte i una de nom fix per a la clau de la base;
- els esborranys oberts i les memòries cau de tema, lletra i idioma al
  `localStorage` del webview, compartit per tot el que s'obri a
  l'equip.

No existien perfils ni grups de comptes.

## Alternatives

1. **Un procés i una finestra per perfil (escollida).** Cada perfil té la seva
   carpeta, la seva memòria cau, les seves entrades de clauer i el seu bloqueig d'instància
   única. Obrir un altre perfil llança l'aplicació amb `--profile=<id>`; si ja
   és obert, es porta al davant.
2. **Canviar de perfil dins del mateix procés.** Exigeix buidar tota la
   memòria del pont, del nucli i de la interfície (cerques,
   notificacions, cues d'enviament) sense deixar-se res. Un oblit barrejaria
   dades, i és just el que la incidència prohibeix.
3. **Reiniciar l'aplicació en canviar.** És més segur que l'opció 2,
   però tanca la feina sense desar del perfil que es deixa.

## Decisió

- La instal·lació existent és el perfil `default` i conserva els seus camins i
  noms de clauer: no hi ha migració.
- Els altres perfils viuen a `profiles/<id>` dins de les carpetes de
  configuració i memòria cau. Les seves entrades de clauer s'anomenen
  `profile:<id>/<nombre>`, de manera que dos perfils amb el mateix compte no
  comparteixen secrets ni clau de base.
- El binari del nucli i les actualitzacions baixades són de la
  instal·lació, no del perfil.
- El pont escriu el perfil a la pàgina
  (`<meta name="oreneta-profile">`) abans que s'executi cap script. La
  pàgina fa servir claus de `localStorage` pròpies de cada perfil; el perfil per
  defecte manté les seves.
- La llista de perfils és un fitxer JSON escrit de manera atòmica. Si està
  malmesa, s'informa i no es reescriu; s'obre el perfil per defecte. Un
  perfil desconegut o mal format a la línia d'ordres també obre el
  perfil per defecte, sense crear-ne un de buit.
- Només se suprimeix des de fora un perfil que no s'ha obert mai: el que té dades
  guarda secrets al clauer que només es troben des de dins.

## Pendent

- Suprimir un perfil amb dades, des de dins, traient abans els seus comptes.
- Grups de comptes i inclusió explícita a les carpetes globals.
- Verificació nativa (N4) a Windows: dos perfils oberts alhora, el
  clauer de Windows amb noms de perfil i la finestra correcta al davant.

## Nota posterior

- 2026-10-17 (#248): el servei del clauer passa de `meron` a `oreneta`. Els
  noms de les entrades, `profile:<id>/<nom>` inclòs, no canvien; les entrades
  que hi ha es mouen soles (ADR-0063).
