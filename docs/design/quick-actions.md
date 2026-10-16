# Accions ràpides (#92, ADR-0022)

## Ús

A **Configuració → Accions ràpides** es crea una acció amb un nom i els seus
passos: marcar com a llegit o no llegit, destacar o treure el destacat, arxivar
o moure a una carpeta (arxivar i moure, només al final).

Amb converses seleccionades, la barra de selecció ofereix cada acció amb la
seva drecera (Alt+1 … Alt+9). Es demana confirmació, i l'informe diu quin pas
s'ha fet en cada conversa i on s'ha aturat si alguna cosa ha fallat.

## Proves

| Nivell | Què cobreix |
|---|---|
| N2 `states/quickActions.test.ts` | Sanejament de la configuració (nom, passos buits, massa passos, passos desconeguts, moure sense carpeta, arxivar abans del final); conjunt fixat en confirmar; cadena que s'atura en la fallada d'una conversa sense aturar les altres; informe amb fallades |
| N2 `components/quick/QuickActions.test.tsx` | Editor que crea una acció i rebutja arxivar abans del final; diàleg que confirma, executa i informa d'una fallada |
