# Interval de comprovació del correu (#270)

Decisió: [ADR-0071](../adr/0071-interval-de-comprovacio-del-correu.md), acceptada el
2026-10-18 amb les opcions 1B, 2B, 3B, 4A, 5A i 6A.

Estat abans d'aquesta incidència (verificat al main `cb6804eb`): a l'escriptori no hi havia
cap comprovació periòdica del correu. La safata d'entrada de cada compte IMAP té un
vigilant IDLE (#121), i les carpetes que es mostren com a columnes del tauler també. La
resta de carpetes només s'actualitzaven en obrir-les; l'aplicació sincronitzava la safata
d'entrada de cada compte una vegada en engegar-se. Els comptes POP3, Exchange (EWS) i
Microsoft Graph no tenen cap vigilant, de manera que no rebien correu nou després de
l'engegada si la persona no obria la carpeta. Només els comptes RSS tenien un interval
propi, i el pont Go el perdia en llegir la llista de comptes (`types.go` no tenia el camp),
de manera que l'escriptori sempre mostrava i feia servir el valor per defecte.

## L'opció

- Cada compte de correu té l'opció «Comprova si hi ha correu nou»: «Només manualment» o
  cada 5, 10, 15, 30, 60 o 120 minuts. Es desa a les preferències del compte
  (`mail_check_interval_minutes` a la columna `prefs`; `0` vol dir «Només manualment»),
  sense cap canvi d'esquema. El nucli manté qualsevol altre valor entre 5 i 1440 minuts i
  respon amb el que ha desat; la interfície també ofereix un valor desat que no sigui a la
  llista.
- Un compte que ja existia abans d'aquesta incidència no té cap valor desat i es comprova
  només manualment. Un compte nou (IMAP, POP3, Exchange, Graph o una bústia compartida)
  es crea amb 15 minuts, el valor per defecte de la comprovació en segon pla de
  l'aplicació mòbil (`BackgroundRefresh.kt`). Tornar a desar un compte (reconnectar-lo,
  canviar-ne el servidor) en conserva la tria.
- L'opció es manté després de reiniciar l'aplicació i en una còpia de seguretat i la seva
  restauració, com totes les preferències del compte; l'arxiu del perfil complet també la
  conserva. El pont Go passa a la interfície aquest interval i el dels comptes RSS: els
  comptes RSS amb un interval desat el fan servir a partir d'ara.

## La comprovació

- El nucli (`meron-core/src/mail_check.rs` i `spawn_mail_check` a `main.rs`) mira cada minut
  quins comptes toquen. No es comprova mai un compte en pausa, l'arxiu local, un compte
  RSS (que manté el seu interval propi) ni un compte amb «Només manualment».
- Un compte comença a comptar el seu interval quan el planificador el veu per primera
  vegada: en engegar l'aplicació (la safata d'entrada ja s'ha sincronitzat),
  quan s'afegeix o quan deixa de ser «Només manualment». El moment de l'última
  comprovació no es desa.
- Cada comprovació demana primer al servidor la llista de carpetes seleccionables i
  comprova, una per una, les carpetes conegudes que hi són:
  - sense les `\Noselect` (com `[Gmail]`) ni les que ja no són al servidor;
  - sense Paperera, Correu brossa ni «Tots» de Gmail, reconegudes pel seu paper (RFC 6154)
    o pel nom, com fa l'arxivament automàtic (ADR-0054);
  - en IMAP, sense les carpetes que en aquell moment tenen un vigilant IDLE (la safata
    d'entrada i les columnes del tauler);
  - per a POP3, només la safata d'entrada, perquè el correu només es baixa en
    comprovar-la; per a Graph, les carpetes del seu propi arbre.
- Cada carpeta s'actualitza amb els 50 missatges més recents, sense tornar a
  sincronitzar Enviats i Esborranys ni baixar-ne cossos per avançat. Una carpeta que la
  interfície ja està sincronitzant es deixa a aquesta sincronització.
- El correu nou de la safata d'entrada passa per les regles i per la resposta automàtica
  d'absència, igual que el que arriba per IDLE; el correu baixat per POP3 també es
  notifica com a correu nou.
- La interfície rep un sol avís per compte i comprovació: el del correu nou, o una sola
  actualització. Si hi ha errors, un sol error per compte, amb quantes carpetes han fallat i el
  primer motiu.
- Una comprovació no s'encavalla amb la següent del mateix compte, i com a màxim dura
  10 minuts; si s'atura, el compte es torna a comprovar a l'interval següent.
- La notificació del servidor (IDLE) continua igual sigui quin sigui l'interval, també amb
  «Només manualment»: aquesta funció no engega ni atura cap vigilant.

## Fora d'abast

- Notificacions del servidor per a Exchange (subscripcions de transmissió en continu
  d'EWS) i per a Graph.
- Les regles per al correu de POP3, que tampoc no s'hi apliquen en obrir la safata
  d'entrada.
- L'aplicació mòbil, que ja té el seu interval de comprovació per a tota l'aplicació.

## Verificació

Proves del nucli per a la tria de carpetes (les vigilades, les no seleccionables o que ja
no hi són, Paperera, Correu brossa i «Tots» de Gmail, comptes sense notificació del
servidor, POP3, arxiu local), per al planificador (un compte nou o que torna d'«Només
manualment» compta des de llavors, «Només manualment», en pausa, l'arxiu local, un valor
il·legible, una comprovació que encara dura, un compte esborrat, la comprovació que acaba
encara que falli) i per a l'error únic; per a la lectura de la preferència (sense valor,
fora de límits, il·legible), per al valor dels comptes nous, el gestor
`account.setMailCheckInterval`, la llista de comptes i la còpia de seguretat. Proves Go del
pont i de la interfície. La comprovació amb un servidor (`check_account_mail`) no té
cap prova automàtica: no hi ha cap servidor IMAP fals amb LIST i SELECT al nucli, i
l'interval mínim de 5 minuts no hi cap a la prova d'integració. La prova amb servidors
reals i a Windows natiu queda pendent.
