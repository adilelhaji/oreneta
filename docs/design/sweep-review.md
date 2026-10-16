# Escombrada sobre el conjunt revisat (#27)

Contracte d'implementació del primer tram de #27. Cobreix l'escombrada per
remitent des de l'escriptori: previsualització, confirmació i resultat. No hi
afegeix persistència ni accions massives noves.

## Problema reproduït

La confirmació tornava a calcular els candidats (`mail.sweep` al pont Go
tornava a cridar la previsualització i passava la llista recalculada a
`messages.move`). Un missatge del mateix remitent arribat després de la
previsualització entrava a l'escombrada sense que ningú l'hagués vist (H01); amb
`keep_newest = 1`, a més, el que abans era el més recent passava a ser
candidat. Un doble clic executava dues escombrades i el resultat es presentava
com un èxit total encara que el moviment fallés a mitges.

## Contracte

- `mail.sweepPreview` emet una **revisió** (`reviewId`): compte, carpeta,
  `UIDVALIDITY` de la carpeta en aquell moment i els UID exactes mostrats, en
  ordre. Viu a la memòria del motor (`sweep_review::Registry`), és d'un sol ús,
  caduca als 15 minuts i se'n desen com a màxim 64 de pendents.
- `mail.sweepExecute {account, review_id}` consumeix la revisió. Es rebutja amb
  un missatge explícit si no existeix, ja s'ha fet servir o ha caducat («torneu a
  previsualitzar»), si pertany a un altre compte, o si la `UIDVALIDITY` actual de
  la carpeta no és la revisada (els UID podrien designar altres missatges). En
  aquests casos no es mou res.
- Amb una revisió vàlida, mou exactament aquests UID a la paperera mitjançant la
  mateixa operació `messages.move`, sense recalcular. Després comprova a la
  memòria cau quins UID revisats continuen a la carpeta d'origen i respon per
  element: `swept`, `sweptUids`, `unresolved`, `complete` i `error`. `complete`
  només és cert sense error i sense elements pendents.
- El pont Go deixa de recalcular: `mail.sweep` exigeix `review_id` i retorna la
  resposta del motor sense tocar-la.
- La interfície confirma amb el `reviewId` de la previsualització, queda ocupada
  fins que es tanca (la revisió és d'un sol ús) i, si el resultat no és complet,
  avisa amb els moguts i els pendents en lloc d'un recompte d'èxit.
  Una fallada tanca el diàleg: el que s'ha mostrat ja no és el que es mouria.

## Decisió pendent, no presa aquí

La discussió de la issue deixava oberta l'elecció entre una revisió efímera en
memòria i un diari durador d'operacions amb resultats per element que
sobrevisquin a un reinici. Aquest tram implementa la **revisió efímera**: un
reinici invalida la previsualització, que costa un clic repetir. El diari
durador continua sent una decisió del responsable (#24/#25); la seva absència no
reintrodueix cap dels quatre riscos d'acceptació.

## Verificació

- Rust: `sweep_review::tests` (un sol ús, compte equivocat, caducitat,
  límit màxim, `UIDVALIDITY` canviada, resultat parcial).
- Go: `TestMailSweepConfirmsTheReviewedPreview`, `TestMailSweepRefusesToActWithoutAReview`.
- Integració amb maddy: previsualització, arribada d'un missatge nou del mateix
  remitent, confirmació que el deixa a la safata d'entrada, segona confirmació
  rebutjada.
- Frontend: `priority.test.ts` per a l'avís de resultat parcial.
- No cobert: canvi real de `UIDVALIDITY` en un servidor (només unitari),
  interrupció física a mitges d'un `MOVE` (el resultat per element es
  calcula a partir de la memòria cau després de l'operació) i proveïdors reals.
