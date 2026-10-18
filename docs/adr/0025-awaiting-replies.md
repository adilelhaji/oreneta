# ADR-0025: Esperant resposta

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Cobreix la porta de #45
  (estats, evidència d'identitat, política de recordatori i
  persistència).
- Data: 2026-10-12.
- Abast: #45.

## Decisió

- **Què s'espera:**
  - el darrer missatge que la persona ha enviat en una conversa, des de la seva
    adreça o un àlies;
  - es desa per Message-ID normalitzat, de manera que sobreviu a moviments,
    baixades noves i reinicis.
- **Estats desats:** `waiting`, `done` i `cancelled`, que són decisions
  de la persona.
- **Estats calculats en llegir, mai desats:** `answered`, `possible` i
  `waiting`.
- **Evidència, sense mirar mai l'assumpte:**
  - un missatge posterior el `In-Reply-To` del qual anomena l'enviat (`direct`), o
    que pertany a la seva conversa (`conversation`);
  - si ve d'algú a qui es va enviar, és una resposta;
  - si ve d'una altra persona, o d'una adreça automàtica (no-reply,
    rebots), és una resposta possible, i la persona decideix;
  - les adreces pròpies i els àlies mai no responen;
  - un missatge anterior a l'enviat tampoc.
- **Correccions:**
  - «és la resposta» fixa aquest missatge;
  - «no és una resposta» el descarta per sempre;
  - cap no es perd en tornar a sincronitzar.
- **Recordatori:**
  - opcional, en segons UTC; per defecte a les 9:00 locals del dia
    triat;
  - s'avisa una sola vegada i només dins de l'aplicació;
  - si ja ha arribat la resposta, no s'avisa;
  - mai no s'envia res a ningú.
- **Comptes:** en suprimir un compte se suprimeixen els seus registres (ADR-0011).

## Pendent

- Triar la data del recordatori al mateix menú; avui són 3 dies.
- Obrir la conversa des de la llista.
- Mostrar la marca a la fila de la conversa.
