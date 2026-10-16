# Línia base de rendiment reproduïble

La incidència #53 estableix un conjunt de dades determinista i un contracte d'informe
abans de proposar cap dependència de virtualització o de bancs de proves (benchmark).

## Contracte del conjunt de dades

`node scripts/perf/mail-dataset.mjs --sizes=1000,10000,100000` genera les mateixes
metadades de missatges a cada execució. El generador no té efectes secundaris i no
contacta cap proveïdor. Cada informe registra les mides sol·licitades, el SHA-256 del
conjunt de dades canònic, el commit, Node/l'entorn d'execució, la plataforma i l'estat
de la memòria cau.

## Mesures

La primera slice mesura per separat la generació del conjunt de dades, l'ordenació
estable i el filtratge per remitent. Les metadades i les sumes de verificació del conjunt
de dades són deterministes; els temps transcorreguts són indicadors de càrrega de treball
propis de cada execució, no afirmacions sobre el p95 de la interfície.
La primera pàgina des de la memòria cau, l'obertura de missatges baixats, l'inici, el
desplaçament i la memòria retinguda requereixen el dispositiu Windows de referència i
continuen com a treball d'acceptació obert.
No es fixa cap llindar al repositori fins que mesures natives repetides el calibrin.

## Reproducció

```text
node scripts/perf/mail-dataset.mjs --sizes=1000,10000,100000 --output=perf-report.json
node --test scripts/perf/mail-dataset.test.mjs
```

Els informes són evidència local tret que s'adjuntin a una execució de CI/nativa amb el
commit i l'entorn exactes. Les dades sintètiques no s'han de presentar mai com a
acceptació amb proveïdors ni com a acceptació nativa.
