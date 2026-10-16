# Adjunts (#93, ADR-0020)

## Ús

La icona del clip de la barra lateral obre **Adjunts**: tots els fitxers del
correu baixat, del més recent al més antic. Es filtren per nom, remitent,
tipus, data i compte. Cada fila ofereix previsualització (quan el tipus ho
admet), desar i obrir el missatge corresponent.

Si hi ha correu sense baixar, un avís indica quants missatges falten: els seus
adjunts no són a la llista. Un fitxer que ja no és al disc es pot recuperar
obrint-ne el missatge.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `store/attachment_list/tests.rs` | Llista amb origen, sense imatges en línia; fitxer sense baixar i enllaç al núvol; cobertura; filtres per compte, nom (paraules), remitent, tipus, dates i mida; `%` literal; pàgines i límit màxim; tipus per MIME o extensió |
| N2 `AttachmentsView.test.tsx` | Llista, recompte, avís de cobertura, desar només el que és al disc, obrir el missatge; filtres enviats al nucli; una resposta antiga no trepitja una de nova |
| N6 `startup.e2e.ts` | Auditoria axe de la vista en mode clar i fosc |
