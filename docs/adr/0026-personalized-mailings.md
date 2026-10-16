# ADR-0026: Enviaments personalitzats amb resultat per destinatari

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Cobreix la porta de #90 (model
  de persistència de l'enviament massiu).
- Data: 2026-10-12.
- Abast: #90.

## Decisió

- **Un missatge per destinatari,** adreçat només a aquesta persona: sense Per a
  compartit, sense còpia oculta, sense dades de ningú en el missatge d'un altre.
- **El que s'ha revisat és el que s'envia:**
  - el nucli genera cada missatge (`merge::preview`); la previsualització
    mostra aquests missatges;
  - en començar, el nucli els torna a generar amb les mateixes dades i només
    desa l'enviament si no hi ha problemes i el nombre coincideix amb el que
    s'ha revisat.
- **Problemes que impedeixen enviar:**
  - adreça no vàlida;
  - destinatari repetit (sense distingir majúscules);
  - marcador desconegut;
  - un valor que falta (queda escrit tal qual a la previsualització);
  - sense destinataris o sense assumpte;
  - més de 500 destinataris.
- **Llista de destinataris:** una línia per persona, o una taula la primera
  línia de la qual anomena les columnes (una es diu `email`). Les columnes són
  marcadors.
- **Persistència:**
  - `merge_batches` desa l'estat i el motiu; `merge_items` desa cada
    missatge ja generat, el seu Message-ID propi, el seu estat i el seu error;
  - cada missatge és un intent de #29 amb el seu Message-ID com a id;
  - en suprimir un compte se suprimeixen els seus enviaments.
- **Enviament:**
  - un cada vegada, amb 3 s de separació per defecte;
  - cada missatge queda acceptat, rebutjat, incert o cancel·lat;
  - un rebuig temporal del servidor (4xx, límit d'enviament) posa en pausa
    l'enviament i deixa el missatge pendent;
  - un missatge incert mai no es repeteix sol;
  - un de rebutjat només es reintenta si la persona ho demana.
- **Aturar, reinici i represa:**
  - aturar marca com a cancel·lat el que falta; el que ja ha sortit continua
    comptat;
  - en reiniciar, l'enviament queda en pausa i el missatge en curs es resol
    pel seu intent (acceptat, incert o pendent si no va començar mai);
  - continuar és decisió de la persona.
- **Proves:** fan servir un servidor simulat o adreces d'exemple; mai
  correu real.

## Pendent

- Cos en HTML i fitxers adjunts.
- Separació configurable a la interfície.
- Desar l'enviament sencer com a esborrany.
