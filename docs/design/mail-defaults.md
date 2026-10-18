# Valors per defecte convencionals del correu (#84)

Amb #84, els perfils nous van passar a fer servir les opcions existents `table`,
`compact` i `traditional`: columnes de remitent, assumpte i data que es poden
ordenar, i missatges apilats a amplada completa. Els missatges més recents i els no
llegits s'expandeixen; els missatges llegits més antics es repleguen. #84 no va
introduir cap mode de renderització, model de missatge, protocol ni mecanisme de
persistència nou.

Des de [#283](https://github.com/adilelhaji/oreneta/issues/283), el valor per
defecte de `list_view` és un valor nou, `auto`: files de dues línies mentre la
llista fa menys de 520 px i la taula a partir d'aquesta amplada; la llista comença
a 360 px ([amplada i files de la llista](message-list-width.md)). La densitat i la
disposició per defecte continuen sent `compact` i `traditional`.

Els valors desats vàlids de `list_view`, `list_density` i `conversation_layout`
substitueixen aquests valors per defecte de manera independent, incloses les
targetes, la taula i el xat. Els valors absents o no vàlids deixen sense canvis el
valor admès actual; no s'executa cap migració massiva de preferències. Els perfils
que no han desat mai aquestes preferències reben els valors per defecte vigents.

Els usuaris amb preferències de targetes, taula o xat desades adopten aquesta
experiència a Configuració > General: Disposició de la conversa = Tradicional; Vista
de la llista = Automàtica; Densitat de la llista = Compacta. Els mateixos controls
restableixen Xat, Targetes, Taula o una altra densitat. Això no restableix el tema,
l'ordenació, els comptes, l'amplada de lectura, la política de marcar com a llegit,
els esborranys ni les signatures. La taula ja té files compactes; la densitat
controla la llista alternativa de targetes i les files de la vista automàtica (#283).
El [lliurament de la selecció a la taula](table-selection.md) (#154) afegeix a la
taula caselles de selecció i controls d'obertura separats; l'acceptació més àmplia
de #34 continua oberta.
El [lliurament dels controls del lector](reader-controls.md) (#156) mostra la mida
del text del cos i millora les capçaleres i les accions de cada missatge sense
canviar el contingut rebut.

La verificació fa servir el punt d'entrada de producció amb respostes sintètiques
del pont, no la pàgina de referència: tots dos temes cobalt, safata d'entrada,
missatge obert, esborrany de resposta, selecció i navegació, restauració de la
configuració antiga, canvis explícits i recàrrega. Des de #283 aquest recorregut es
prova dues vegades: amb la taula desada i amb les files de la vista automàtica d'un
perfil que no ha triat cap vista. No s'envia cap missatge extern.
La certificació nativa i amb proveïdors continua al registre d'acceptació; la
correcció del lector a 600 px d'amplada i el poliment complet de les columnes i
del lector continuen a #85/#34/#35.
