# ADR 0005: Judicis explícits de correu brossa per missatge

Estat: Acceptada — 2026-09-10. El mantenidor va triar l'opció A per a la incidència #50.
Ampliada el 2026-10-17 (#254).

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
de clau forana del compte el garanteixen la clau de la taula i la consulta. Els camins
de trasllat de correu transfereixen el judici de la fila d'origen de la
memòria cau a la fila de destinació actualitzada mitjançant la identitat
estable del proveïdor (Gmail/message-id) abans de suprimir la fila d'origen.
Una conversa o un missatge que no existeixen continuen sense tenir cap
efecte. Aquesta decisió no introdueix cap trasllat automàtic, adaptador de
servidor/Sieve ni comportament nou del proveïdor.

## Conseqüències

- Els comptadors agregats es poden reparar tornant a aplicar les files de judici actuals.
- Un judici sobreviu quan es torna a jutjar i no es pot confondre amb un resultat derivat.
- Moure un missatge jutjat en preserva la decisió actual i la contribució als
  agregats; suprimir una fila de la memòria cau no pot deixar evidència
  d'aprenentatge òrfena.
- Els comptes existents migren sense omplir retroactivament decisions
  d'usuari inventades.
- La implementació ha d'actualitzar els agregats de manera transaccional i
  provar els casos de duplicat, substitució, missatge inexistent i aïllament
  entre comptes.

## Ampliació del 2026-10-17: desfer un judici (#254)

Decisió per delegació del propietari, que va aprovar la incidència #254 el
2026-10-17. La incidència demanava una ordre de reversió o un testimoni de
desfer retornat per `mail.markJunk`; s'han fet totes dues coses, de manera
additiva i sense canvi d'esquema.

Desfer «Marca com a brossa» o «No és brossa» des de l'avís de desfer (d'una
conversa o d'una selecció) també desfà el que aquell judici havia ensenyat al
filtre après. No cal cap canvi d'esquema: el judici per missatge ja és el
registre que permet retirar-ne la contribució exacta.

- `mail.recordSpamJudgment` també respon `judgment`, el canvi que ha fet a la
  fila del missatge a `spam_judgments`: l'estat d'abans i el de després
  (`before`, `after`, amb la decisió i les instantànies del remitent i de
  l'assumpte; `null` vol dir que no hi havia fila). Totes dues claus són
  obligatòries. Un judici repetit respon `before` igual a `after`, i revertir-lo
  no canvia res. `mail.markJunk` el torna a la interfície com a
  `spam_judgment`, i no el torna si no s'ha registrat res.
- L'ordre nova `mail.revertSpamJudgment` rep aquest canvi i torna la fila a
  `before` amb el mateix mecanisme de retirar i aplicar de les substitucions,
  dins d'una sola transacció que també recalcula els veredictes. Només ho fa si
  la fila encara conté exactament `after`. Si un judici posterior del mateix
  missatge l'ha substituït, o si el missatge ja no és a la memòria cau, no
  canvia res i respon `reverted: false`; la interfície torna a moure la
  conversa de totes maneres. Els judicis d'altres missatges, també els del
  mateix remitent, no es toquen mai, perquè cada contribució és la seva pròpia
  fila. Quan reverteix el judici, respon el canvi invers, que al seu torn desfà
  la reversió.
- El canvi és opac per a la interfície i es confia en el seu contingut perquè
  només el genera el nucli i només el torna la mateixa aplicació. La comparació
  amb `after` impedeix aplicar-lo sobre una fila que ha canviat.
- La interfície reverteix el judici abans de tornar a moure la conversa, mentre
  encara és a la carpeta on es va registrar. Si el trasllat de tornada falla,
  aplica el canvi invers: cada conversa es desfà sencera o no es desfà gens. Si
  la reversió falla, no mou res i ho diu. En una selecció, es desfà conversa per
  conversa i s'atura a la primera fallada; només queden desfetes les anteriors.
- Límits coneguts:
  - Si el canvi invers tampoc no es pot aplicar, el lector veu l'error del
    trasllat, i el de l'aprenentatge queda al registre de l'aplicació.
  - Si el servidor ha fet el trasllat però el nucli informa d'un error en
    actualitzar la memòria cau, el canvi invers torna a posar el judici a la
    fila de la carpeta de brossa, que la sincronització següent esborrarà.
  - `reverted: false` no distingeix un judici posterior d'una fila que ja no
    és a la memòria cau; en el segon cas, la contribució ja havia quedat òrfena
    abans de desfer.
  - Desfer una selecció només s'ofereix quan tota la selecció s'ha marcat. Si
    l'acció s'atura a mig camí, les converses ja mogudes conserven el judici, i
    «No és brossa» n'hi registra un de nou en lloc de revertir-lo.
  - Les files no tenen número de revisió. Si, després del judici, la mateixa
    fila canviés dues vegades i tornés exactament a l'estat que el judici havia
    deixat (brossa, no brossa i brossa de nou, sense moure el missatge), la
    reversió no ho distingiria i desfaria el judici. Per la interfície no s'hi
    pot arribar mentre l'opció de desfer és visible. L'avís de desfer és únic i
    dura 5 segons, i qualsevol avís posterior el substitueix. Això inclou l'avís
    d'error que dona marcar com a brossa una conversa que ja és a la carpeta de
    brossa, l'únic camí que torna a jutjar la mateixa fila com a brossa sense
    moure-la. L'altre judici sense trasllat és «No és brossa» des de l'avís de
    correu brossa. Repetir la mateixa decisió no compta com un judici nou,
    perquè aquest ADR ja la deixa sense efecte. Afegir el número de revisió
    seria un canvi d'esquema i demanaria una decisió pròpia.
