# Llistes de remitents i execució revisada de regles (#50, ADR-0028)

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `spam/tests.rs` | Bloquejat o permès decideix i ho diu, per sobre del que s'ha après |
| N1 `store/tests.rs` | Patrons d'adreça i de domini; l'adreça abans que el domini; per compte; els veredictes desats canvien a l'instant; treure de la llista |
| N1 `rules/tests.rs` | El pla és el que es pot fer: primer les marques i un sol moviment (falla amb el codi anterior) |
| N1 `rules/run.rs` | La revisió és d'un sol ús i només si no han canviat el compte, la carpeta, les regles ni el temps |
| N2 `SpamAndRuns.test.tsx` | Bloquejar, permetre i treure per compte, indicant l'error; executar les regles desades tal com es van previsualitzar i informar de cada pas fallit |

En escriure la prova de la interfície va aparèixer un defecte real: l'estat de
la previsualització descartava la revisió que retornava el nucli. Està
corregit.
