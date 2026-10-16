# Pendent de resposta (#45, ADR-0025)

## Ús

Al menú d'una conversa en què s'ha escrit:
- **Espera resposta (recordatori d'aquí a 3 dies)** marca l'últim missatge
  enviat;
- **Pendents de resposta…** obre la llista.

La llista indica, per a cada missatge:
- si té resposta i com se sap;
- quines respostes són possibles i per què hi ha dubte, amb «És la resposta» o
  «No és una resposta»;
- si ja ha passat el recordatori.

«Fet» i «Deixa d'esperar» el tanquen.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `awaiting/tests.rs` | Resposta directa d'un destinatari en còpia; resposta a la conversa sense `In-Reply-To`; l'assumpte sol no respon mai; àlies propis i correu anterior exclosos; respostes automàtiques i de desconeguts com a possibles, amb decisió de la persona; moviment, nova baixada i reinici; recordatori una sola vegada i no després d'una resposta; errors i estats; supressió del compte |
| N2 `Awaiting.test.tsx` | Llista amb l'evidència i el dubte; decisió sobre una possible resposta; deixar d'esperar; recordatori a les 9.00 locals |
