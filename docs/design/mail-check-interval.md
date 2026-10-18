# Interval de comprovació del correu (#270)

**Estat: prototip pendent de l'[ADR-0071](../adr/0071-interval-de-comprovacio-del-correu.md)**
(proposada). Aquest document descriu el que fa el prototip de la branca
`issue-270-sync-interval`, sense PR; el comportament definitiu depèn de les decisions de
l'ADR, on també es descriuen els problemes coneguts del prototip.

Estat abans d'aquesta incidència (verificat al main `cb6804eb`): a l'escriptori no hi havia
cap comprovació periòdica del correu. La safata d'entrada de cada compte IMAP té un
vigilant IDLE (#121), i les carpetes que es mostren com a columnes del tauler també. La
resta de carpetes només s'actualitzaven en obrir-les; l'aplicació sincronitzava la safata
d'entrada de cada compte una vegada en engegar. Els comptes POP3, Exchange (EWS) i
Microsoft Graph no tenen cap vigilant, de manera que no rebien correu nou després de
l'engegada si la persona no obria la carpeta. Només els comptes RSS tenien un interval
propi, i el pont Go el perdia en llegir la llista de comptes (`types.go` no tenia el camp),
de manera que l'escriptori sempre mostrava i feia servir el valor per defecte.

## Què fa el prototip

- Cada compte de correu té l'opció «Comprova si hi ha correu nou»: «Només manualment» o
  cada 5, 10, 15, 30, 60 o 120 minuts. Es desa a les preferències del compte
  (`mail_check_interval_minutes` a la columna `prefs`; `0` vol dir «Només manualment»),
  sense cap canvi d'esquema. El nucli manté qualsevol altre valor entre 5 i 1440 minuts i
  respon amb el que ha desat. Un compte sense cap tria fa servir 15 minuts, el mateix valor
  per defecte que ja té la comprovació en segon pla de l'aplicació mòbil
  (`BackgroundRefresh.kt`); vegeu la decisió 1 de l'ADR.
- El nucli (`meron-core/src/mail_check.rs` i `spawn_mail_check` a `main.rs`) mira cada minut
  quins comptes toquen. Per a cada compte que toca, sincronitza les carpetes que la
  notificació del servidor no cobreix, una per una, pel mateix camí que en obrir-les:
  - IMAP: totes les carpetes conegudes del compte que en aquell moment no tenen cap
    vigilant IDLE (la safata d'entrada i les columnes del tauler en tenen);
  - POP3: la safata d'entrada, perquè el correu només es baixa en comprovar-la;
  - Exchange (EWS) i Microsoft Graph: totes les carpetes, perquè aquí encara no tenen
    notificació del servidor.
- La notificació del servidor (IDLE) continua igual sigui quin sigui l'interval, també amb
  «Només manualment»: aquesta funció no engega ni atura cap vigilant.
- No es comprova mai un compte en pausa, l'arxiu local ni un compte RSS (que manté el seu
  interval propi). Una comprovació que encara dura no s'encavalla amb la següent.
- Després d'engegar l'aplicació, la primera comprovació periòdica arriba un interval després,
  perquè la safata d'entrada ja s'ha sincronitzat en engegar. El moment de l'última
  comprovació no es desa.
- L'opció es manté després de reiniciar l'aplicació i en una còpia de seguretat i la seva
  restauració, com totes les preferències del compte; l'arxiu del perfil complet també la
  conserva. Ara el pont Go passa a la interfície tant aquest interval com el dels comptes
  RSS.

Cada carpeta s'actualitza amb els 50 missatges més recents (el valor per defecte de
`messages.sync` al nucli).

## Problemes coneguts del prototip

Són els que motiven les decisions 2 a 4 de l'ADR: les carpetes `\Noselect` i les que ja no
són al servidor es comproven i donen un error a cada interval; cada carpeta torna a
sincronitzar Enviats i Esborranys i en baixa cossos per avançat; cada carpeta avisa la
interfície per separat; el correu que arriba per aquesta via no passa per les regles ni per
la resposta automàtica d'absència, i el de POP3 no avisa de correu nou.

## Fora d'abast

- Notificacions del servidor per a Exchange (subscripcions de transmissió en continu
  d'EWS) i per a Graph.
- L'aplicació mòbil, que ja té el seu interval de comprovació per a tota l'aplicació.

## Verificació del prototip

Proves del nucli per a la tria de carpetes (IMAP sense les vigilades, POP3, Exchange i
Graph, arxiu local), el càlcul de quan toca un compte (també «Només manualment», una
comprovació que encara dura i un compte esborrat), la lectura de la preferència (valor per
defecte, fora de límits, il·legible), el gestor `account.setMailCheckInterval` i la llista
de comptes, i la còpia de seguretat. Proves Go del pont (paràmetres, valor desat, la llista
de comptes amb els dos intervals) i de la interfície (opcions, «Només manualment», el valor
que ha desat el nucli, error). El planificador mateix (`spawn_mail_check`,
`check_account_mail`) encara no té cap prova automàtica, i el prototip no s'ha compilat ni
provat a la CI.
