# Constructor de cerques (#43, ADR-0021)

## Ús

El botó de configuració al costat del quadre de cerca obre **Opcions de
cerca** amb el que ja s'ha escrit repartit en camps:
- paraules;
- remitent i destinatari (diversos separats per comes, qualsevol
  d'ells);
- assumpte i etiqueta;
- llegit o no llegit, destacats i amb adjunts;
- des d'un dia i abans d'un dia.

**Cerca** escriu la cerca al quadre amb la sintaxi de sempre.

Una cerca desada recorda on es va desar i, en obrir-la, es torna a
aquell compte i aquella carpeta.

A dalt de tot, una línia diu on busca la cerca i si hi entren les carpetes
amagades (#273): amb una carpeta oberta, només aquella; a les carpetes
unificades i a Destacats, totes, les amagades incloses.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `search/tests.rs` | Anada i tornada d'un corpus (operadors, cometes, diversos valors, dates vàlides i no vàlides, URL amb dos punts, espais); escriptura estable; valors buits ignorats |
| N2 `SearchBuilder.test.tsx` | El constructor s'obre amb la lectura del nucli i escriu a través del nucli; dies tal com els compta el nucli; cerca desada amb àmbit que torna a la seva carpeta; compatibilitat amb les desades anteriorment; la línia d'àmbit i les carpetes amagades (#273) |
