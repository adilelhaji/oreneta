# ADR-0071: Interval de comprovació del correu al costat de la notificació del servidor

- Estat: **acceptada** el 2026-10-18 pel propietari («Sí a todo»): les opcions
  recomanades, 1B, 2B, 3B, 4A, 5A i 6A.
- Data: 2026-10-18.
- Abast: #270, filla de #96. Relacionada amb #121 (IDLE), ADR-0035 (POP3), ADR-0004
  (Microsoft Graph), ADR-0037 (còpies programades) i ADR-0054 (arxivament automàtic).
  Detall del comportament: [mail-check-interval.md](../design/mail-check-interval.md).

## Context

Estat verificat al main `cb6804eb` abans de cap canvi:

- A l'escriptori no hi ha cap comprovació periòdica del correu. IDLE vigila la safata
  d'entrada de cada compte IMAP i les carpetes que es mostren com a columnes del tauler.
  La interfície sincronitza la safata d'entrada una vegada en engegar l'aplicació i,
  cada 15 minuts, només actualitza la llista de carpetes (sense missatges).
- Les altres carpetes IMAP només s'actualitzen quan s'obren. Els comptes POP3, Exchange
  (EWS) i Microsoft Graph no tenen cap vigilant: després de l'engegada no reben correu
  nou si la persona no obre la carpeta.
- Els comptes RSS tenen un interval propi, programat a la interfície; el pont Go el
  perdia en llegir la llista de comptes (`types.go` no tenia el camp), de manera que
  l'escriptori sempre feia servir el valor per defecte.
- El camí d'arribada per IDLE (`sync_and_notify`) aplica les regles i la resposta
  automàtica d'absència; el camí de sincronització en obrir una carpeta
  (`spawn_message_sync`) no les aplica.

#270 demana un interval per compte (també «només manualment») aplicat a les carpetes
que la notificació del servidor no cobreix, sense tocar-la, i que es conservi en
reiniciar i en una còpia de seguretat.

Un prototip a la branca `issue-270-sync-interval` (sense PR) ho fa amb el planificador
al nucli, 15 minuts per defecte i totes les carpetes no vigilades. La revisió prèvia hi
va trobar problemes que depenen de decisions de producte, no de codi:

- les carpetes `\Noselect` (com `[Gmail]`) i les que ja no són al servidor es
  conserven a la memòria cau de carpetes; comprovar-les fa sortir un error de
  sincronització a cada interval;
- cada carpeta sincronitzada torna a sincronitzar Enviats i Esborranys i en baixa
  cossos per avançat: un compte amb N carpetes fa unes 3N sincronitzacions per
  interval, i a Gmail «Tots», «Paperera» i «Correu brossa» repeteixen els mateixos missatges;
- cada carpeta emet el seu `mail.synced`, i la interfície recarrega la vista per a cada
  un;
- el correu que arriba per la comprovació periòdica no passa per les regles ni per la
  resposta automàtica d'absència, i el de POP3 no avisa de correu nou.

## Decisions que ha de prendre el propietari

### 1. Valor per defecte

- **A.** 15 minuts per a tots els comptes, també els que ja existeixen (el valor per
  defecte de la comprovació en segon pla de l'aplicació mòbil). Canvia el comportament
  de tots els comptes en actualitzar: més trànsit i més risc de límits del servidor
  (Gmail, Graph).
- **B.** «Només manualment» per als comptes existents i 15 minuts per als comptes nous.
- **C.** «Només manualment» per a tots fins que la persona en triï un, com l'ADR-0037 i
  l'ADR-0054, que comencen desactivats.

### 2. Quines carpetes es comproven

- **A.** Totes les carpetes conegudes que no tenen vigilant IDLE (IMAP) i totes les
  carpetes (EWS i Graph), excepte les `\Noselect` i les que el darrer llistat del
  servidor ja no ha retornat.
- **B.** Com A, però sense Paperera, Correu brossa i «Tots» de Gmail, reconegudes pel seu
  paper (RFC 6154) o pel nom, com fa l'ADR-0054.
- **C.** Només la safata d'entrada (per als comptes sense notificació del servidor) i
  les carpetes amb paper d'Enviats i Esborranys; la resta continua actualitzant-se en
  obrir-les.

### 3. Què fa cada comprovació

- **A.** Sincronitzar cada carpeta amb els 50 missatges més recents, sense tornar a
  sincronitzar Enviats i Esborranys per a cada una ni baixar-ne cossos per avançat, i
  avisar la interfície una sola vegada per compte i comprovació.
- **B.** Com A, i a més aplicar al correu de la safata d'entrada que arriba per aquesta via les
  regles i la resposta automàtica d'absència, com IDLE; per a POP3, avisar del correu
  baixat.
- **C.** Fer servir el mateix camí que en obrir una carpeta, amb els seus costos.

### 4. Errors

- **A.** Un error d'un compte en una comprovació periòdica surt una vegada per compte i
  comprovació, i un error de carpeta inexistent o no seleccionable no surt.
- **B.** Com quan s'obre una carpeta: un error per carpeta.

### 5. On viu el planificador

- **A.** Al nucli, com l'ADR-0037 i l'ADR-0054: funciona encara que la interfície no tingui
  el focus, i coneix quines carpetes vigila IDLE.
- **B.** A la interfície, com l'interval RSS.

### 6. Fila del registre d'acceptació

- **A.** Només una nota datada.
- **B.** Una fila nova (com CAL-01, NOTE-01 o ACC-01, afegides el 2026-10-12 per a treball
  lliurat sense fila).

## Recomanació

1B (no canvia res per a qui ja té comptes; els comptes nous es comporten com un client de
correu habitual), 2B, 3B, 4A, 5A i 6A. Amb aquestes opcions, la notificació del servidor
continua igual, i el cost d'una comprovació és el d'una sincronització per carpeta útil.

## Decisió

El propietari va acceptar la recomanació el 2026-10-18 («Sí a todo»):

- **1B.** Els comptes que ja existien no tenen cap valor desat i es comproven només
  manualment; un compte nou es crea amb 15 minuts.
- **2B.** Es comproven les carpetes conegudes que el servidor llista ara com a
  seleccionables (sense les `\Noselect` ni les que ja no hi són), sense Paperera, Correu
  brossa ni «Tots» de Gmail (pel seu paper o pel nom) i, en IMAP, sense les que tenen un
  vigilant IDLE.
- **3B.** Cada carpeta es sincronitza amb els 50 missatges més recents, sense tornar a
  sincronitzar Enviats i Esborranys ni baixar-ne cossos per avançat. El correu nou de la
  safata d'entrada passa per les regles i per la resposta automàtica d'absència, com amb
  IDLE; el de POP3 també es notifica. La interfície rep un sol avís per compte i comprovació.
- **4A.** Un error en una comprovació periòdica surt una vegada per compte i comprovació,
  amb quantes carpetes han fallat.
- **5A.** El planificador viu al nucli.
- **6A.** Només una nota datada al registre d'acceptació.

## Conseqüències

- L'opció es desa a les preferències del compte (`mail_check_interval_minutes` a
  `prefs`, `0` = «només manualment»), sense canvi d'esquema; es conserva en reiniciar,
  en una còpia de seguretat i a l'arxiu del perfil.
- El pont Go passa a la interfície l'interval de correu i el dels comptes RSS: els
  comptes RSS amb un interval desat començaran a fer-lo servir (abans sempre
  s'aplicava el valor per defecte).
- Fora d'abast: la notificació del servidor per a EWS i Graph, i l'aplicació mòbil, que
  ja té el seu interval per a tota l'aplicació.
