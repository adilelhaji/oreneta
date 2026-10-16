# ADR 0005: Judicis explícits de correu brossa per missatge

Estat: Acceptada — 2026-09-10. El mantenidor va triar l'opció A per a la incidència #50.

## Decisió

La decisió explícita del lector sobre el correu brossa es desa separada del
veredicte après. S'afegeix una taula local `spam_judgments` amb clau per compte
i per la identitat local estable del missatge. Es desa una única decisió actual
(`spam` o `not spam`) per missatge. La columna existent `messages.spam` continua
sent un estat derivat que admet valors nuls i mai no es fa servir com a prova
que el lector hagi pres una decisió.

Enviar repetidament la mateixa decisió no té cap efecte. Canviar una decisió
primer treu la contribució anterior dels agregats de remitent i de paraules de
l'assumpte i després aplica la substituta dins d'una única transacció. Això
manté l'aprenentatge idempotent i fa que les correccions siguin reversibles
sense inflar l'evidència.

La identitat és el `messages.id` local, qualificat per `account`; l'abast
forà del compte el garanteixen la clau de la taula i la consulta. Els camins
de trasllat de correu transfereixen el judici de la fila d'origen de la
memòria cau a la fila de destinació actualitzada mitjançant la identitat
estable del proveïdor (Gmail/message-id) abans de suprimir la fila d'origen.
Una conversa o un missatge que no existeixen continuen sense tenir cap
efecte. Aquesta decisió no introdueix cap trasllat automàtic, adaptador de
servidor/Sieve ni comportament nou del proveïdor.

## Conseqüències

- Els comptadors agregats es poden reparar tornant a aplicar les files de judici actuals.
- Un judici sobreviu a un nou judici i no es pot confondre amb un resultat derivat.
- Moure un missatge jutjat en preserva la decisió actual i la contribució als
  agregats; suprimir una fila de la memòria cau no pot deixar evidència
  d'aprenentatge òrfena.
- Els comptes existents migren sense omplir retroactivament decisions
  d'usuari inventades.
- La implementació ha d'actualitzar els agregats de manera transaccional i
  provar els casos de duplicat, substitució, missatge inexistent i aïllament
  entre comptes.
