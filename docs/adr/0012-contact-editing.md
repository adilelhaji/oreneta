# ADR-0012: Edició de contactes i conflictes d'escriptura

- Estat: acceptada. Per a Exchange, el punt 3 queda substituït per ADR-0066,
  acceptada pel propietari el 2026-10-17: les persones d'Exchange ja
  s'editen, amb la mateixa regla de conflictes, sense l'evidència d'un
  servidor real que s'hi demanava, que continua pendent (N5).
- Data: 2026-10-11.
- Abast: #41. La política de conflictes s'aplica també a les tasques (#103) i
  a qualsevol escriptura nova al calendari.
- Aprovació humana: «Local y después CardDAV» i «No guardar y mostrar ambas»,
  escollides entre les opcions de
  [la proposta](../design/contact-editing-decisions.md).

## Decisió

1. **Primer, una llibreta local** («en aquest equip»), sense servidor.
2. **Després, CardDAV**, amb versió (ETag): `PUT` amb `If-Match` i alta amb
   `If-None-Match: *`, provada contra Radicale a CI. Les llibretes sense permís
   d'escriptura no ofereixen edició.
3. **Google i Exchange no s'editen** en aquesta decisió. Google necessita el
   permís `contacts`, que depèn dels registres OAuth propis (#144).
   Exchange necessita evidència d'un servidor real.
4. **Conflictes.** Si el servidor respon que l'element ha canviat, no es desa
   res: es torna a llegir la versió del servidor i es mostren totes dues perquè la
   persona triï. Mai no es fusiona ni se sobreescriu en silenci.
5. Supressió, duplicats, vCard i fotos segons la proposta: confirmació que anomena la llibreta, enllaç local que es pot desfer i sense fotos per URL remot.

## Conseqüències

`people` necessita una columna de versió, que s'emplena en la sincronització
següent. Una llibreta local queda només a l'equip, i la interfície
ho diu.
