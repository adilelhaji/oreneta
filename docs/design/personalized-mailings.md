# Enviaments personalitzats (#90, ADR-0026)

## Ús

Paleta d'ordres → **Enviament personalitzat…**:
1. Es trien el compte, els destinataris, l'assumpte i el text, amb
   marcadors com ara `{{to.firstName}}` o el nom de qualsevol columna.
2. **Previsualitza cada missatge** mostra tots els missatges tal com
   sortiran i el que cal corregir, amb la seva línia.
3. **Envia N missatges** demana confirmació. Qualsevol canvi obliga a
   tornar a revisar.

Després es veu l'estat de cada destinatari, amb **Atura**, **Continua** i
**Torna a provar els rebutjats**.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `merge/tests.rs` | Llista i taula amb cometes; cada missatge només amb les seves dades; problemes per destinatari (repetit, adreça, falta un valor) i de l'enviament (marcador desconegut, sense destinataris, sense assumpte, més de 500); l'enviament és el que s'ha revisat o res; un Message-ID per missatge; resultat per missatge; pausa davant d'un rebuig temporal; reprendre sense repetir els incerts; tornar a provar només els rebutjats; aturar; reinici resolt per l'intent de #29; rebuig temporal enfront de rebuig; supressió del compte |
| N1 `main.rs` | Resposta de l'enviament → estat del missatge |
| N2 `Merge.test.tsx` | Previsualització de cada missatge abans de poder enviar; s'envia exactament el que s'ha revisat; estat per destinatari i motiu de la pausa; problemes marcats que impedeixen enviar; un canvi obliga a tornar a revisar |
