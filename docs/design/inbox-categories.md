# Categories de safata (#91, ADR-0023)

## Ús

A **Configuració → Categories de safata** es creen categories amb nom, color i,
opcionalment, condicions. Cada condició compara el remitent, els destinataris o
l'assumpte. Una categoria pot agafar el correu si es compleix qualsevol condició
o només si es compleixen totes. L'ordre de la llista és l'ordre en què es
proven.

A la safata d'entrada apareixen les pestanyes **Tot**, una per categoria i
**Altres**, cadascuna amb el seu recompte.

El menú contextual d'una conversa indica en quina categoria és i per què, i
ofereix:
- moure-la a una altra categoria;
- posar sempre el correu d'aquell remitent a la categoria actual;
- tornar la decisió a les regles.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `categories/tests.rs` | Regles en ordre i la resta a Altres; res no queda fora de les pestanyes; condicions que s'han complert; correccions de conversa abans que de remitent; correccions a categories suprimides ignorades o eliminades; supervivència a una nova baixada del servidor; aïllament per compte; recomptes amb no llegits i cobertura; validació; supressió del compte |
| N1 `store` | Migració 45 i versió de l'esquema |
| N2 `Categories.test.tsx` | Pestanyes amb recomptes i cobertura; faceta compatible amb altres filtres; faceta treta si la categoria ja no existeix o fora de la safata; motiu llegible i correcció; desfer una correcció de remitent; res fora de la safata; editor que rebutja noms repetits i condicions buides |
| N3 e2e | Auditoria axe de la bústia amb pestanyes en temes clar i fosc |
