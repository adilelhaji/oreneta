# ADR-0020: Llista d'adjunts sense índex de contingut

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #93.

## Context

#93 demana un espai amb tots els adjunts, filtres i enllaç al seu missatge.
Per a cercar dins dels fitxers, exigeix abans un disseny aïllat i amb
límits de recursos.

## Alternatives

1. **Llista llegida de les metadades que ja desa cada missatge baixat
   (escollida).** No hi ha un segon índex que es pugui desincronitzar, i la
   cobertura es diu sempre.
2. **Taula pròpia d'adjunts mantinguda a cada sincronització.** És més
   ràpida en bústies enormes, però afegeix un estat que pot divergir. Es
   podrà afegir si les mesures ho demanen.
3. **Indexar el contingut** (PDF, Office) en un procés a part. Necessita
   dependències d'anàlisi de documents amb historial de fallades de
   seguretat, i un procés aïllat amb límits. Queda fora fins que s'aprovi.

## Decisió

- **Origen:** la llista surt de `messages.json.attachments` de cada missatge
  de correu baixat. Les imatges sense nom (logotips i signatures dins
  del text) no es compten com a fitxers.
- **Filtres:** compte, paraules del nom, remitent, tipus (deduït del
  tipus MIME o de l'extensió), data i mida. Pàgines de 200, amb un
  màxim de 500.
- **Cobertura:** cada resposta diu quants missatges hi ha i quants estan
  baixats; els altres tenen adjunts que aquí no es coneixen.
- **Fitxers no disponibles:**
  - un que ja no és al disc (la memòria cau es poda) es llista sense clau, i s'hi
    ofereix obrir-ne el missatge;
  - un enllaç al núvol es diu tal qual.
- **Identitat:** cada fitxer s'identifica per compte, carpeta, UID i
  índex; la clau al disc inclou les mateixes dades, de manera que una
  consulta antiga no pot obrir un altre fitxer.
- **Contingut:** no es cerca dins dels fitxers, i la interfície ho diu.

## Conseqüències

- Cost de la consulta: es recorren els missatges baixats amb adjunts.
  Si una bústia gran la fa lenta, l'alternativa 2 és el pas següent.
