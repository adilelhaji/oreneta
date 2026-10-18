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
  sense cap canvi d'esquema. El nucli ajusta qualsevol altre valor als límits de 5 i
  1440 minuts i respon amb el que ha desat; la interfície també ofereix un valor desat que
  no sigui a la llista.
- Un compte que ja existia abans d'aquesta incidència no té cap valor desat i es comprova
  només manualment. Un compte nou (IMAP, POP3, Exchange, Graph o una bústia compartida)
  es crea amb 15 minuts, el valor per defecte de la comprovació en segon pla de
  l'aplicació mòbil (`BackgroundRefresh.kt`). Tornar a desar un compte (reconnectar-lo,
  canviar-ne el servidor) en conserva la tria.
- Un valor desat il·legible (que no és un nombre) es llegeix com si no n'hi hagués cap,
  és a dir, «Només manualment», com passa amb totes les preferències del compte: no es
  comprova res que ningú no hagi triat. Si la base de dades no es pot llegir, el compte no
  es comprova i el nucli ho escriu al seu registre a cada minut.
- L'opció es manté després de reiniciar l'aplicació i en una còpia de seguretat i la seva
  restauració, com totes les preferències del compte; l'arxiu del perfil complet també la
  conserva. El pont Go passa a la interfície aquest interval i el dels comptes RSS: els
  comptes RSS amb un interval desat el fan servir a partir d'ara.

## La comprovació

- El nucli (`meron-core/src/mail_check.rs` i `spawn_mail_check` a `main.rs`) mira cada minut
  quins comptes toquen. No es comprova mai un compte en pausa, l'arxiu local, un compte
  RSS (que manté el seu interval propi) ni un compte amb «Només manualment». Només es
  comproven els comptes que el nucli té carregats, com passa amb IDLE.
- Un compte comença a comptar el seu interval quan el planificador el veu per primera
  vegada: en engegar l'aplicació (la safata d'entrada ja s'ha sincronitzat),
  quan s'afegeix o quan deixa de ser «Només manualment». El moment de l'última
  comprovació no es desa. Si el rellotge del sistema torna enrere, l'interval compta des
  de l'hora nova.
- En IMAP i Exchange, cada comprovació demana primer al servidor la llista de carpetes
  seleccionables; a Graph, fa servir l'arbre de carpetes, que ja es manté al dia. Es
  comproven, una per una, les carpetes conegudes que hi són:
  - sense les `\Noselect` (com `[Gmail]`) ni les que ja no són al servidor;
  - sense Paperera, Correu brossa ni cap carpeta amb el paper «Tots» (com la de Gmail),
    reconegudes pel seu paper (RFC 6154) o pel nom en anglès, com fa l'arxivament automàtic
    (ADR-0054);
  - en IMAP, sense les carpetes que en aquell moment tenen un vigilant IDLE (la safata
    d'entrada i les columnes del tauler). Un vigilant que no aconsegueix connectar-se continua
    comptant com a vigilant: la seva carpeta no entra a la comprovació periòdica;
  - per a POP3, només la safata d'entrada, perquè el correu només es baixa en
    comprovar-la.
- Cada carpeta s'actualitza amb els 50 missatges més recents (POP3 baixa tot el correu
  nou), sense tornar a sincronitzar Enviats i Esborranys ni baixar-ne cossos per avançat.
  Una carpeta que la interfície ja està sincronitzant no es torna a sincronitzar.
- El correu nou de la safata d'entrada passa per les regles i per la resposta automàtica
  d'absència, igual que el que arriba per IDLE. Si la interfície ja ha sincronitzat la
  safata d'entrada abans (en obrir-la), aquest correu ja no és nou per a la comprovació i no
  hi passa, com tampoc no hi passa amb IDLE. El correu baixat per POP3 només es notifica
  com a correu nou; la primera baixada d'una safata d'entrada buida no es notifica.
- La interfície rep un sol avís per compte i comprovació: el del correu nou, o una sola
  actualització, amb les carpetes sincronitzades (perquè el tauler recarregui les seves
  columnes). Si hi ha errors, un sol error per compte, amb quantes carpetes han fallat i el
  primer motiu. Aquests avisos van marcats com a periòdics: una sincronització que el
  tauler espera no es dona per acabada ni per fallida per ells.
- Una comprovació no s'encavalla amb la següent del mateix compte, i com a màxim dura
  10 minuts; si s'atura, surt un error, el compte es torna a comprovar a l'interval
  següent, i el correu nou que ja s'havia sincronitzat en aquella comprovació no es
  notifica.
- La notificació del servidor (IDLE) continua igual sigui quin sigui l'interval, també amb
  «Només manualment»: aquesta funció no engega ni atura cap vigilant.

## Fora d'abast

- Notificacions del servidor per a Exchange (subscripcions de transmissió en continu
  d'EWS) i per a Graph.
- Les regles i la resposta automàtica d'absència per al correu de POP3, que tampoc no s'hi
  apliquen en obrir la safata d'entrada.
- L'aplicació mòbil, que ja té el seu interval de comprovació per a tota l'aplicació.

## Verificació

Proves automàtiques:

- del nucli (`mail_check/tests.rs`): la tria de carpetes (les vigilades, les no
  seleccionables o que ja no hi són, Paperera, Correu brossa i «Tots», comptes sense
  notificació del servidor, POP3, arxiu local); el planificador (un compte nou o que torna
  d'«Només manualment» compta des de llavors, «Només manualment», en pausa, l'arxiu local,
  un valor il·legible, una comprovació que encara dura, un compte esborrat, el rellotge
  que torna enrere, la comprovació que acaba encara que falli) i l'error únic;
- `imap::selectable_folder_names` amb un servidor IMAP fals (`\Noselect` i
  `\NonExistent`);
- la lectura de la preferència (sense valor, fora de límits, il·legible), el valor dels
  comptes nous creats per `upsert_account`, el gestor `account.setMailCheckInterval` i la
  llista de comptes (`main.rs`, `store/tests.rs`), i la còpia de seguretat
  (`backup/tests.rs`);
- del pont Go (`accounts_mail_check_test.go`) i de la interfície
  (`AccountTogglesSection.test.tsx`, i la recàrrega de les columnes del tauler a
  `kanbanData.test.ts`);
- la integració amb maddy continua cobrint IDLE
  (`TestIntegrationMailFlow/idle_pushes_folder_updates_while_watched`) després que la
  sincronització d'IDLE s'hagi separat de l'avís (`sync_and_handle_arrivals`).

Sense prova automàtica: la comprovació d'un compte amb un servidor (`check_account_mail`,
`mail_check_folders`, `pop3_check`, `SyncClaim`, l'error de temps esgotat) i el valor de
15 minuts d'un compte de Graph activat (`graph::mail`). Per provar-ho caldria un servidor
fals amb LIST, SELECT i FETCH per a tota una comprovació, o una prova amb maddy, on
l'interval mínim de 5 minuts no cap. La prova amb servidors reals i a Windows natiu queda
pendent.
