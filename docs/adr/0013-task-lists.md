# ADR-0013: Llistes de tasques locals

- Estat: acceptada.
- Data: 2026-10-11.
- Abast: primer lliurament de #103.
- Aprovació humana: «Listas locales y migración», escollida entre les opcions
  de [la proposta](../design/full-tasks-decisions.md).

## Decisió

- Llistes i tasques soltes desades a l'equip, amb títol, nota, data
  límit, recordatori, prioritat (baixa, normal o alta), estat i enllaç
  opcional a una conversa.
- Les tasques enllaçades actuals passen a una llista local «Seguiment de
  correu» sense perdre cap camp. La regla d'una tasca oberta per
  conversa es manté.
- Sense sincronització, repetició ni delegació en aquest lliurament. El pas
  següent és CalDAV (VTODO), amb la política de conflictes de l'ADR-0012 i una
  decisió sobre la cua sense connexió que es pren juntament amb la del calendari.

## Conseqüències

La migració es prova en anada i tornada (N1) i no canvia el comportament de
les tasques enllaçades validat a #42.
