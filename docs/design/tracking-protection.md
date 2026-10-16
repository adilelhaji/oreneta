# Protecció contra rastrejadors (#107, ADR-0029)

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `privacy/tests.rs` | La còpia inclosa es llegeix i diu què és; es bloquegen els rastrejadors de correu reals i no les imatges normals; sintaxi (`\|\|`, `\|`, `^`, `*`, tipus, `domain=`, `third-party`, opcions que reescriuen, cosmètiques, expressions regulars, excepcions, `important`, adreces sense esquema, `data:` i `cid:`); un missatge advers (entitats, seqüències d'escapament CSS, `<style>`, `@import`, `background`, `srcset`) no demana res a cap rastrejador i conserva les imatges normals i els enllaços; actualització comprovada que, si falla, conserva la llista anterior; excepcions per missatge i per compte |
| N2 `TrackerNotice.test.tsx` | Quants i quins, amb la seva regla; carregar-los en un missatge només després de confirmar-ho, i desfer-ho; res a mostrar; la llista en ús i l'actualització només a petició |

Missatges de prova sintètics; cap prova no fa peticions a la xarxa.
