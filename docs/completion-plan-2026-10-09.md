# Pla per completar Oreneta davant d'eM Client, amb verificació per capes

Revisió: **2026-10-09**. Codi auditat: `9ac12e603121dcc00bb91d5e5a7914b6245e75a7`
(main, CI en verd a les set suites: [execució 37448687522](https://github.com/adilelhaji/oreneta/actions/runs/37448687522)).
Referència estable: **eM Client 10.4.5674.0 per a Windows**, sense canvis.

Aquest document actualitza la seqüència del [pla competitiu](competitive-delivery-plan.md)
del 2026-10-05 amb el que s'ha lliurat des d'aleshores i la converteix en una llista ordenada
d'iteracions fins a tres candidats amb abast declarat. Cada iteració inclou
els seus lliuraments de prova; la secció 5 defineix què vol dir «ben provat» i quina
infraestructura de verificació falta construir. No substitueix la
[matriu de paritat](emclient-parity-plan.md) ni l'[auditoria d'incidències](competitive-backlog-audit.md),
i no aprova cap arquitectura nova. Les xifres i els estats provenen de GitHub,
del registre i d'una inspecció del codi; **no són evidència d'acceptació**.

## 1. Estat actual en xifres

| Indicador | Valor (2026-10-09) |
|---|---|
| Incidències obertes | 81 (79 del programa de paritat + #181 zoom natiu + #188 paquet de la Store) |
| PR oberts | 0 |
| Registre d'acceptació (#22) | 39 files: **0 verified**, 4 implemented-unverified, 8 partial, 27 unassessed |
| Manifest del backlog | 50 lliuraments: 40 unassessed, 5 implemented-unverified, 5 partial |
| Lliurat des de l'auditoria del 05-10 | 15 PR fusionats (#151–#187) |
| Mida del codi | Frontend ≈48 k línies TS/TSX, motor Rust ≈68 k, app Go ≈10 k |
| Binari validat | Cap per al SHA actual; l'executable local és anterior (#114/#147) |

### Cobertura de proves existent, per capa

| Capa | Què hi ha | Quant | On s'executa |
|---|---|---|---|
| Unitàries Rust (motor) | Protocol IMAP/SMTP/EWS, analitzador MIME, store, Graph, criptografia, calendari | ≈890 proves | job `rust` |
| Unitàries Go (app d'escriptori) | Comptes, rutes, notificacions, actualitzacions, enganxament, S/MIME, Graph OAuth | 164 funcions de prova en 33 fitxers | jobs `go`, `go-windows` |
| Unitàries i de component TS | Estats, lib, components, fixtures de referència (baseline) | ≈915 casos en 93 fitxers | job `frontend` (bun test) |
| Entrada de producció | Arrencada i navegació amb el pont Wails simulat, 1440/1024/600 px, clar/fosc, zoom | `frontend/e2e/startup.e2e.ts` + `frontend/baseline/` (Playwright) | job `frontend` |
| Integració aïllada | Flux IMAP/SMTP real contra maddy a Docker, 39 subproves, 12 resultats d'usuari, IDLE ×3 | `integration_test.go` + informe JSON | job `integration` |
| Mòbil | Proves Kotlin shared/ui | 61 fitxers | job `mobile` |
| Política de CI | Porta de publicació, registre, acceptació, validació Windows | 64 proves Node | job `workflow-policy` |
| Natiu Windows | Arrencada, reinici, elecció de Graph, zoom amb roda i teclat | `scripts/test-windows-startup.ps1` | `windows-validation.yml`, **manual** |
| Rendiment | Generador determinista 1k/10k/100k, ordenació i filtre | `scripts/perf/` | local, sense CI |
| Proveïdor real | Procediment documentat, **no executat** | [provider-acceptance.md](provider-acceptance.md) | cap |

### Buits de verificació que el pla ha de tancar

- **Sense mesura de cobertura** en cap capa; no es pot exigir que no baixi.
- **Go sense proves dedicades** en fitxers amb lògica: `mail.go` (981 línies), `oauth.go`
  (499), `sidecar.go` (407), `calendar.go` (366), més `sweep.go`, `rules.go`, `junk.go`,
  `pgp.go`, `smime.go`, `feeds.go`. Una part està coberta de manera indirecta per
  `app_*_test.go`.
- **Rust amb mòduls grans sense proves inline**: `rss.rs` (1792 línies, 0 proves),
  `backend.rs` (595, 0), `thread_list.rs` i `thread_read.rs` (≈600 cadascun, 4–5 proves),
  `unified.rs` (2). `backup.rs` depèn només de `backup/tests.rs`.
- **Integració només IMAP/SMTP**: no hi ha servidor EWS, Graph, CalDAV ni CardDAV a
  la CI. `ews-smoketest.py` existeix, però només contra un Exchange real i a mà.
- **Natiu Windows limitat a l'arrencada**: cap flux de correu (afegir compte,
  llegir, respondre, recuperar esborrany) s'executa en el binari real.
- **Accessibilitat sense comprovació automàtica**: les proves de producció miren el focus
  i el teclat, però no executen cap auditor de contrast/rols.
- **Rendiment sense dispositiu de referència** i sense llindars calibrats.
- **Cap fila `verified`** del registre: tota l'evidència és sintètica.

### El que es va lliurar entre el 05-10 i el 09-10

- Disseny: controls compartits (#152), selecció de taula (#154), lector (#156),
  focus dels diàlegs (#158), columnes configurables i ADR-0009 (#160), coherència de
  pantalles secundàries (#177), jerarquia visual de la bústia (#187).
- Operació: cerca de configuració ES/EN (#163), salut de la sincronització per compte
  (#165, #168), magatzem durable d'esborranys (#169, PR #174), el lector espera
  l'iframe (#175).
- Evidència: ADR-0010 recuperació completa local (#146), informe d'acceptació
  IMAP/SMTP per operació (#184), validació d'entrada Win32 i zoom natiu (#180,
  #182, #183).

Tot plegat és **parcial** respecte a les incidències pare (#33–#39, #149, #150, #145,
#147): fixtures sintètics i proves de component, sense evidència nativa ni de
proveïdor real.

## 2. Comparació capacitat per capacitat

Resultat d'inspeccionar el codi actual, no de provar-lo contra eM Client.
«Existeix» vol dir que hi ha implementació i proves automàtiques; «sense evidència»,
que falta la verificació nativa/de proveïdor que exigeix el registre; «absent», que no
hi ha codi per a la funció.

### Existeix, falta l'acceptació nativa/de proveïdor

| Capacitat | On | Incidència que tanca l'acceptació |
|---|---|---|
| Correu IMAP/SMTP/EWS: carpetes, sincronització, enviament, marques, moure | `meron-core/src/{imap,smtp,exchange}.rs` | #98/#145, #46/#48 |
| Graph **només lectura** (carpetes, delta, cossos) | `meron-core/src/graph/` | #141 accions, #142 adjunts, #143 enviament |
| Bústia: columnes, densitat, selecció, paginació, vistes desades | `frontend/src/components/threads/` | #30, #34, #36 |
| Cerca amb operadors i filtres ràpids | `SearchUnderstoodBar`, `QuickFilterBar`, `SavedSearchMenu`, `search/` | #31, #43 |
| Lector: HTML aïllat, zoom, accions per missatge, impressió | `components/chat/`, `lib/print*.ts` | #35 |
| Redacció: signatures, plantilles, corrector, adjunts, enviament programat, desfer, posposar | `components/composer/`, `states/{scheduledSends,sendQueue}` | #39/#170, #40, #88, #89, #45 |
| Regles locals, correu brossa idempotent, etiquetes, prioritat | `rules/`, `spam/`, `labels.go`, `priority/` | #50, #95 |
| Calendari: agenda/setmana/mes, edició, recurrència, Google, Exchange, subscripcions `.ics` | `components/calendar/`, `calendar/` | #100, #101 |
| Invitacions i disponibilitat (parcial, Exchange) | `EventDetails.tsx`, `exchange.rs` | #102 |
| Persones (CardDAV), tasques enllaçades a missatge, kanban, RSS | `carddav/`, `tasks.go`, `components/{people,tasks,kanban}` | #28, #41, #42 |
| PGP i S/MIME | `crypto/`, `pgp.go`, `smime.go` | #9, #12, #49 |
| Assistent amb proveïdor explícit i resultats revisables | `assistant.rs`, ADR-0006/0007 | #51, #52 |
| Privadesa: imatges remotes, diagnòstic amb dades emmascarades, còpia de la configuració | `readerHtml.ts`, `applog.go`, `backup.go` | #54, #107 |
| Escriptori: notificacions, safata del sistema, mailto, servidor intermediari (proxy), dreceres, actualitzacions, OOF | arrel Go | #114/#147, #181 |
| Configuració cercable ES/EN i salut dels comptes | #163, #165 | #149, #150 |

### Absent en el codi (requereix implementació i, en alguns casos, decisió)

| Capacitat d'eM Client | Incidència | Decisió prèvia |
|---|---|---|
| Categories de safata amb correcció de l'usuari | #91 | No |
| Notes independents amb sincronització | #104 | **Sí**: emmagatzematge i identitat |
| Llistes de tasques completes i sincronitzades | #103 | **Sí**: conflicte amb la tasca única per fil |
| POP3 | #97 | **Sí**: retenció i identitat |
| Importació/exportació (mbox, eml, pst) i arxius locals | #112 | Formats que cal admetre |
| Correu personalitzat massiu | #90 | No |
| Macros d'acció ràpida | #92 | No |
| QuickText | #88 | No |
| Espai de tots els adjunts | #93 | No |
| Preferits i colors de carpeta, arrossegament segur | #87 | No |
| Barra lateral contextual (agenda, persona, historial de fitxers) | #86 | No |
| CalDAV | #101 | No |
| Regles al servidor i reenviament/vacances per proveïdor | #94 | Per proveïdor |
| Grups de comptes i perfils aïllats | #99 | **Sí**: model de perfil |
| Graph: escriptura, adjunts, enviament, calendari, contactes, delegació | #141–#143, #47, #48 | ADR-0004 ja aprovada |
| Còpia completa xifrada: captura, restauració aïllada, planificació | #171–#173 | ADR-0010 ja aprovada |
| Gramàtica i traducció sense connexió | #105, #106 | ADR-0001 ja aprovada |
| Adjunts al núvol i reunions en línia | #108, #109 | **Sí**: proveïdors i consentiment |
| Xat (directe, grup, canal) | #110 → #111 | **Sí**: límits de l'adaptador |
| Paquet de Microsoft Store validat | #188 | Identitat de Partner Center |

Nota: la vista «xat» actual d'Oreneta és un mode de conversa de correu
heretat de Meron, no el xat d'eM Client; no compta per a C26.

## 3. Què vol dir «completar l'app»

Definim tres candidats acumulatius. Cadascun té un abast declarat i es
pot lliurar als usuaris per separat; «completa» en sentit de paritat és el
tercer. Cap no es considera assolit fins que les seves files del registre siguin
`verified`.

| Candidat | Abast | Portes del pla anterior |
|---|---|---|
| **C-A: Correu Windows professional** | Diversos comptes IMAP/M365/EWS, llegir, cercar, respondre amb fitxers, esborranys recuperables, organització bàsica, instal·lació i actualització comprovades | R0 + R1 |
| **C-B: Agenda i informació personal** | C-A + invitacions completes, contactes editables, tasques i notes completes, importació i còpia completa | R2 |
| **C-C: Paritat estable a Windows** | C-B + automatització, categories, privadesa/idioma, integracions, xat, POP3, perfils; macOS/Linux amb evidència pròpia | R3 + R4 |

## 4. Seqüència d'iteracions amb les seves proves

Períodes fixos (timeboxes) de dues setmanes amb **un lliurament principal** per iteració, les seves proves
al mateix PR i una línia d'evidència (#22) per lliurament. Les iteracions s'ordenen
per risc i per dependència; no són promeses de data. La **iteració 0**
construeix la infraestructura de prova que necessiten les altres; sense ella, les
iteracions 3–4 (Graph) i 8 (calendari) només es podrien provar amb simulacions.
L'accessibilitat (#37), la privadesa (#54) i el rendiment (#53) es revisen a cada
iteració, no al final. Els nivells de prova (N1–N6) es defineixen a la secció 5.

### Iteració 0: infraestructura de verificació

| Lliurament | Resultat | Incidència |
|---|---|---|
| Cobertura mesurada a la CI | `cargo llvm-cov`, `go test -cover`, cobertura de bun; informe per paquet pujat com a artefacte; encara sense llindar | #53 (nova filla) |
| Servidor CalDAV/CardDAV a la integració | Contenidor Radicale al costat de maddy; fixture de calendari i contactes sintètics | #101/#41 (nova filla) |
| Simulador Graph a la integració | Servidor HTTP local amb respostes enregistrades (carpetes, delta, 429, 401, continuació); els fixtures Rust actuals passen a executar-se contra ell | #47 (nova filla) |
| Banc de proves (harness) EWS reproduïble | Convertir `ews-smoketest.py` en una prova Go amb l'etiqueta `ews` que faci servir enregistraments SOAP quan no hi ha servidor; execució real només manual | #46/#98 (nova filla) |
| Fluxos natius a Windows | Ampliar `test-windows-startup.ps1` amb un segon script de fluxos: afegir un compte IMAP contra maddy local, llegir, respondre, tancar i recuperar un esborrany | #147 (nova filla) |
| Auditor d'accessibilitat | `@axe-core/playwright` a `startup.e2e.ts` i a la baseline; els errors crítics bloquegen, la resta es comunica | #37 |

Criteri de sortida: les set suites existents continuen en verd, l'informe de
cobertura apareix a cada PR i la validació Windows inclou almenys un flux
de correu complet.

Estat (2026-10-09): cobertura a la CI, auditoria axe (amb una violació greu real
corregida al tema fosc) i Radicale amb cinc casos CardDAV lliurats; el
simulador Graph s'ajorna a la iteració 3 sobre els servidors falsos ja
existents, els enregistraments EWS esperen la dependència 6 i l'script de fluxos
natius queda dissenyat sense executar. Detall i límits a
[verification-infrastructure.md](verification-infrastructure.md). La iteració 1
va començar per #29 ([contracte](design/outgoing-mail-recovery.md)).

### C-A: correu Windows (R0/R1)

| It. | Lliurament principal | Incidències | Proves obligatòries al PR | Sortida comprovable |
|---|---|---|---|---|
| 1 | **Integritat P0** | #27 escombrada limitada, #29 enviament incert durable, #28 contactes davant d'una sincronització parcial, #9/#12 criptografia | N1: reproducció de cada risc com a prova que falla abans i passa després; N3: enviament interromput contra maddy (tall després de DATA, reinici del sidecar) i CardDAV parcial contra Radicale; N1 criptografia amb claus generades per GnuPG/OpenSSL a la prova | Cada risc amb reproducció automatitzada i correcció fusionada; decisions #24/#25 només on bloquegin |
| 2 | **Esborranys i redacció complets** | #170, #39, #40 | N1 magatzem d'esborranys (concurrència, disc ple, registre corrupte); N2 editor amb reinici simulat, pestanyes múltiples, adjunts; N4 flux natiu «escriure, tancar l'app, tornar a obrir» | Reinici, error de disc i pestanyes múltiples sense pèrdua; visualitzacions prèvies per tipus i error |
| 3 | **Escriptura a Graph** | #141 accions, #142 adjunts | N1 Rust per operació (èxit, 429 amb Retry-After, 401 revocat, resposta parcial, cancel·lació); N3 contra el simulador Graph; N2 la UI desactiva el que no s'admet també per teclat i en lot | Marques/moure/esborrar amb resultat recuperable; adjunts de mida limitada |
| 4 | **Enviament per Graph i continuïtat d'Exchange** | #143, #46, #48 | N3 enviament amb desconnexió entre `createMessage` i `send`, verificant que no es duplica; banc de proves EWS amb enregistraments per a delegació i OOF; N5 una execució autoritzada contra M365 si hi ha compte | Enviament amb resultat incert durable; exposició d'EWS Online documentada per compte/operació |
| 5 | **Shell de correu tancat** | #33, #34, #35, #36, #87, #30 | N2 producció a 599/600/601, 768/769, 1024/1025, 1440 i zoom del 200 %; captures de pantalla de referència en clar/fosc comparades; N3 ordenació estable amb arribades concurrents contra maddy; N6 axe sense errors crítics | Flux complet de lectura/organització a l'app nativa; preferits, colors i arrossegament; ordenació estable entre pàgines |
| 6 | **Candidat instal·lable** | #144, #147, #181, #148, #188 (només validació), #145 | N4 instal·lar, actualitzar des de la versió anterior, desinstal·lar i restaurar un perfil sintètic; N6 mesures 1k/10k/100k al dispositiu de referència; N5 files en directe IMAP i M365 amb el procediment de [provider-acceptance.md](provider-acceptance.md) | Executable del SHA exacte amb manifest; files S01 i de proveïdor a `verified` on hi hagi evidència; pilot #55 decidit |

Criteri de sortida C-A: els vuit fluxos de #32 aplicables (tots menys
les invitacions) completats en el binari natiu amb comptes de prova autoritzats,
cap fila obligatòria de correu en `partial`, cobertura de `mail.go`,
`oauth.go`, `sidecar.go`, `imap.rs`, `smtp.rs`, `exchange.rs` i `graph/` no
inferior a la de la iteració 0 i cap fitxer Go de lògica de correu sense prova.

Estat de la iteració 1 (2026-10-10): les cinc incidències tenen la seva slice
lliurada a la branca amb proves i document de contracte. #29 resultat incert
durable ([contracte](design/outgoing-mail-recovery.md)); #27 escombrada sobre la
revisió ([contracte](design/sweep-review.md)); #28 CardDAV complet o res
([contracte](design/carddav-complete-sync.md)); #12 claus i missatges de GnuPG
([anàlisi](design/pgp-gnupg-interop.md)); #9 validesa i `contentType` S/MIME
([contracte](design/smime-validity.md)). Queden oberts a cada incidència els
criteris que exigeixen un proveïdor real, evidència nativa o decisions
d'arquitectura (diari durable d'escombrades, cadena i revocació S/MIME, AEAD de
LibrePGP), registrats a cada document.

Estat de la iteració 2 (2026-10-10): #170 porta l'editor complet al
magatzem local, amb adjunts, revisions, conflicte visible, làpida (tombstone) en tancar
i migració des de localStorage
([contracte](design/editor-draft-recovery.md)). De #39 es lliuren els
destinataris amb coma al nom en respostes i contactes, i l'avís
d'adjunt oblidat ([contracte](design/composition-safety.md)). De #40, l'escapada
de plantilles de text i la visualització prèvia de PDF que no redibuixava la pàgina 1
ni conservava el document en tornar a renderitzar
([contracte](design/template-preview-safety.md)). Continuen oberts el flux
natiu «escriure, tancar i tornar a obrir» (N4), la durabilitat de la resposta
ràpida, la correspondència de les imatges inserides amb els seus bytes i la mesura
de memòria de les visualitzacions prèvies al dispositiu de referència (N6).

Estat de la iteració 3 (2026-10-10): #141 permet canviar missatges a Graph
(llegit, marca, moure, copiar dins del compte, esborrar) després d'un permís
`Mail.ReadWrite` demanat a part, amb el lot resolt abans d'enviar, aturada a la
primera fallada, resultat incert sense repetició i reconciliació per delta
([contracte](design/graph-message-actions.md)). #142 llegeix els adjunts i les
imatges inserides per MIME amb l'analitzador d'IMAP, en limita la mida i indica
que els adjunts al núvol no estan disponibles
([contracte](design/graph-attachments.md)). El simulador Graph continua sent el
servidor de bucle local amb respostes en línia. La certificació amb un
inquilí (tenant) real (#98) i l'evidència nativa continuen pendents.

Estat de la iteració 4 (2026-10-10): #143 envia des de comptes Graph amb
`Mail.Send` demanat a part, amb el MIME d'Exchange, l'intent durable de #29,
un límit de 4 MB i resultat incert sense repetició
([contracte](design/graph-sending.md)). En revisar-ho es va veure que la branca EWS
enviava en clar un missatge marcat per xifrar o signar; corregit. De #48 es
va verificar que una bústia compartida no desa la contrasenya del delegat, i es
van corregir les respostes automàtiques locals: no responen a rebots,
respecten `X-Auto-Response-Suppress` i inclouen el dia final complet
([verificació](design/delegation-and-automatic-replies.md)). #46 queda com a
estudi amb el calendari verificat, matriu EWS/Graph i marca dels comptes EWS
que apunten a Exchange Online ([estudi](design/ews-online-exposure.md)). El
client EWS només fa servir Basic, de manera que ja no funcionava contra Exchange Online.
Calendari, contactes, directori i bústies compartides per Graph queden com a
slices proposades pendents de decisió.

Estat de la iteració 5 (2026-10-10): una auditoria del shell contra la branca
va trobar nou defectes, cadascun reproduït amb una prova i corregit
([registre](design/mail-shell-defects.md)). Lot que desfeia el que ja s'havia fet i
lot concurrent (#34); impressió amb imatges remotes, sense `sandbox` i amb
missatges omesos sense avís (#35); vistes filtrades sense «carregar-ne més» (#30);
capçalera que prometia una ordenació no aplicada, posposats reordenats, amplada de
llista que deixava el lector en 149 px i versió de les vistes sobreescrita (#36);
text secundari il·legible en temes personalitzats (#33); carpeta nova fora
de l'arbre fins a sincronitzar (#87). Continuen oberts les captures de referència
comparades (N2), l'ordenació estable amb arribades concurrents contra maddy (N3),
el flux natiu (N4), i els preferits, colors i arrossegament de #87. L'ordenació per
columna a la cerca, als destacats, als posposats i a la vista unificada amb canals queda com a
decisió del nucli (ADR-0003).

Estat de la iteració 6 (2026-10-10): només avança el que no necessita Windows
natiu, registres propis ni decisions del responsable. #144: una compilació
amb `-tags distributable` no compila cap registre OAuth heretat i desactiva
cada inici de sessió sense client propi injectat. Els valors mal formats
compten com a absents i el nucli rep només els acceptats. La CI comprova que
el binari no porta els valors heretats
([inventari i contracte](oauth-registrations.md)). #147: el paquet
d'actualització es torna a verificar abans d'instal·lar-lo, i la substitució de
l'executable portable rebutja fitxers malmesos o aliens i torna enrere si falla
([contracte](design/update-install-safety.md)). #145: la guia d'acceptació ja
descriu el que fa Graph des de les iteracions 3 i 4. Queda per al
responsable:
- crear registres propis i decidir la verificació de Google;
- compilar les versions publicades amb `distributable`;
- signatura, identitat de Partner Center i evidència nativa (#147, #188, #148);
- el mecanisme de zoom (#181);
- la política de privacy.html: diu que no surt res excepte cap als servidors
  de correu, però l'assistent pot enviar contingut a un proveïdor remot que
  configura l'usuari.

### C-B: agenda i informació personal (R2)

| It. | Lliurament principal | Incidències | Proves obligatòries al PR | Decisió prèvia |
|---|---|---|---|---|
| 7 | **Còpia completa i restauració** | #171, #172, #173, #113 | N1 format versionat (contrasenya incorrecta, corrupció byte a byte, versió futura, interrupció a mig fer); N3 captura amb escriptures concurrents del sidecar; N4 restauració nativa en un perfil aïllat i activació reversible | ADR-0010 ja aprovada |
| 8 | **Calendari i invitacions** | #100, #101 (CalDAV), #102 | N3 contra Radicale (recurrència, zones horàries, conflicte d'ETag) i banc de proves EWS (convidar, acceptar, cancel·lar, free/busy); N1 iTIP amb fixtures RFC 5546; N2 vistes amb dates límit (canvi d'hora, anys de traspàs) | Cap |
| 9 | **Contactes i tasques** | #41, #42, #103 | N3 edició CardDAV amb conflicte i desduplicació; N1 model de tasques amb migració des de la tasca enllaçada; N2 fluxos de recuperació | Model de tasques completes (ADR nova) |
| 10 | **Notes, importació i perfils** | #104, #112, #99 | N1 importació mbox/eml amb un corpus mal format (capçaleres trencades, codificacions mixtes, adjunts truncats) i propietat d'anada i tornada exportar→importar; N3 aïllament entre perfils (credencials, memòria cau, esborranys); N4 canvi de perfil natiu | Emmagatzematge de notes, formats d'importació, model de perfil (tres ADR) |

Estat de la iteració 7 (2026-10-11): el que existeix és la còpia de la
configuració d'ADR-0008, no la del perfil complet. Es va corregir que una còpia
fallida esborrés l'anterior: ara s'escriu a part i se li canvia el nom en acabar.
La captura i la restauració del perfil complet esperen decisions del
responsable ([decisions](design/full-profile-archive-decisions.md)): xifratge
per blocs per a perfils grans, límits de l'inventari, secrets opcionals,
clau de la base restaurada a Windows, i límits i còpies programades.

Estat de la iteració 8 (2026-10-11): una auditoria del calendari va trobar
defectes que es van reproduir amb proves i es van corregir
([registre](design/calendar-subscriptions.md)):
- subscripcions `.ics` llegides segons l'RFC 5545 (excepcions, `DURATION`, hora
  flotant, zones de Windows, dies sencers a l'est d'UTC, esdeveniments que
  travessen la finestra, `webcal://`), i una subscripció trencada ja no atura les
  altres;
- Google no sobreescriu canvis aliens (`If-Match`), i editar tota la sèrie ja
  no la retalla ni n'esborra la regla;
- regles amb el dia de la setmana i la data final que veu la persona, i nom
  de zona IANA també a Windows;
- dies sencers d'Exchange a la seva data;
- vista setmanal correcta els dies de canvi d'hora;
- sense botons de resposta per a l'organitzador;
- esdeveniments en calendaris locals;
- recordatori de nou si l'esdeveniment es mou;
- finestres d'Exchange amb més ocurrències de les que caben en una resposta.

La CI executa les proves de calendari també a Tòquio i Los Angeles. Continuen
pendents:
- adaptador CalDAV, model iTIP, cua sense connexió i importació/exportació
  ICS (cadascun amb la seva ADR, com demanen #101 i #102);
- a Exchange: política de conflictes, edició de sèries, patrons mensuals
  relatius (cal canviar la bifurcació d'`ews-rs`) i zona a les escriptures,
  amb evidència de proveïdor;
- lliure/ocupat i el flux complet d'invitació a Exchange i Google (N5).

Estat de la iteració 8 (continuació, 2026-10-11, per delegació):
- **#101 CalDAV:** descobriment, lectura per finestra i escriptura amb ETag,
  incloses excepcions i EXDATE, provades contra Radicale (ADR-0018,
  [registre](design/caldav.md)); importar i exportar `.ics` sense duplicats.
- **#102 invitacions per correu:** es llegeixen i es responen només en prémer,
  amb resposta iTIP a l'organitzador i l'esdeveniment en un calendari local o
  CalDAV (ADR-0019). Pendent: contraproposta, disponibilitat i N5.

Estat de la iteració 9 (2026-10-11):
- **#42:** la validació de les tasques enllaçades va trobar i corregir sis
  defectes, cadascun amb la seva prova
  ([registre](design/message-linked-tasks.md)): tasques duplicades, fils
  moguts de carpeta, nota esborrada en fallar la lectura, error en brut en
  tornar a obrir i tasques de comptes eliminats.
- **Pendent:** decidir què cal fer amb 17 taules més que queden en eliminar
  un compte.
- **#41 i #103:** no hi ha codi; esperen l'aprovació de les seves propostes
  ([contactes](design/contact-editing-decisions.md),
  [tasques](design/full-tasks-decisions.md)).

Estat de la iteració 9 (tancament de codi, 2026-10-11):
- **Contactes:** llibreta local, edició a CardDAV amb ETag (provada contra
  Radicale), importar i exportar vCard, i duplicats enllaçables
  ([registre](design/local-address-book.md)).
- **Tasques:** llistes, tasques soltes, prioritat i recordatoris
  ([registre](design/task-lists.md)).
- **Pendent:** l'escriptura a Google i Exchange (ADR-0012) i la
  sincronització de tasques (ADR-0013).

Estat de la iteració 10 (2026-10-11, decisions per delegació):
- **#112:** arxiu local amb importació EML/MBOX (ADR-0014) i exportació
  d'una carpeta a MBOX amb anada i tornada provada
  ([registre](design/mail-import.md)). Pendent: Thunderbird/Postbox i PST.
- **#104:** notes locals amb text enriquit, imatges, etiquetes,
  cerca, conflicte per revisió i paperera (ADR-0015,
  [registre](design/notes.md)). Pendent: adjunts de fitxer i
  sincronització amb proveïdors.
- **#171 i #172:** còpia completa del perfil xifrada amb age (ADR-0017),
  comprovació sense tocar el perfil en ús, i restauració preparada a part,
  activada amb diari i reversible ([registre](design/profile-archive.md)).
  Pendent: N4 a Windows.
- **#173 (2026-10-12, per delegació):** còpies programades del perfil,
  desactivades per defecte, comprovades abans de comptar-les, amb una retenció que
  mai no esborra l'última bona ni fitxers aliens (ADR-0037,
  [registre](design/scheduled-backups.md)).
- **#103 (2026-10-12, per delegació):** una llista de tasques es pot
  enllaçar amb una col·lecció CalDAV (VTODO): canvis locals pendents,
  enviats amb versió, lectura tot o res i conflictes sense fusió
  silenciosa (ADR-0039, [registre](design/caldav-tasks.md)). Pendent:
  Google Tasks, Graph To Do, EWS i N5 amb proveïdors reals.
- **#99 (2026-10-12, per delegació):** un perfil amb dades es pot
  esborrar escrivint-ne el nom, si no és obert. Abans, el seu nucli esborra
  les seves entrades del clauer (ADR-0038, [registre](design/profiles.md)).
- **#99, grups de comptes (2026-10-12, per delegació):** vistes amb nom
  sobre els comptes triats, mostrades amb la safata unificada i sense
  moure res (ADR-0040, [registre](design/account-groups.md)).
- **Importar des de Thunderbird (2026-10-12, per delegació):** perfils i
  carpetes a l'arxiu local, amb visualització prèvia. No s'importen els missatges
  que Thunderbird tenia com a esborrats. PST queda pendent: falta un lector
  fiable (ADR-0041, [registre](design/thunderbird-import.md)).
- **Interfície en els 19 idiomes:** els textos afegits en aquest pla ja són
  a tots els catàlegs.
- **#104, fitxers a les notes (2026-10-12, per delegació):** es desen
  amb la nota dins del perfil, de manera que la còpia completa els
  inclou. Fins a 25 MB per fitxer (ADR-0042,
  [registre](design/note-attachments.md)).
- **#99:** perfils aïllats, cadascun a la seva finestra i procés, amb
  carpetes, clauer i emmagatzematge del webview propis (ADR-0016,
  [registre](design/profiles.md)). Pendent: esborrar un perfil amb dades,
  grups de comptes i la verificació a Windows (N4).

Criteri de sortida C-B: flux d'invitació complet verificat a Exchange i
Google (N5); restauració assajada a Windows (N4); importació d'almenys
mbox/eml amb un corpus de regressió versionat al repositori.

### C-C: paritat estable i altres plataformes (R3/R4)

| It. | Lliurament principal | Incidències | Proves obligatòries al PR | Decisió prèvia |
|---|---|---|---|---|
| 11 | **Organització avançada** | #91 categories, #92 macros, #93 adjunts, #43 vistes vives, #95 etiquetes | N1 classificació determinista amb correcció de l'usuari persistent; N3 macros només sobre el conjunt revisat (regressió de #27); N2 vistes vives que no amplien el lot | Cap |
| 12 | **Automatització i enviament avançat** | #94, #88, #89, #90, #45 | N3 regles de servidor per proveïdor (Sieve contra maddy, regles de safata d'EWS enregistrades); N1 enviament massiu amb resultat parcial per destinatari; N3 desfer/programat amb reinici a mig fer | Capacitats per proveïdor |
| 13 | **Privadesa i idioma** | #107, #105, #106, #49, #50 | N1 bloqueig de rastrejadors amb un corpus d'HTML real anonimitzat; N1 gramàtica/traducció amb models empaquetats i comprovació d'absència de xarxa (prova que falla si hi ha un sòcol); N5 interoperabilitat criptogràfica amb Thunderbird/Outlook amb comptes de prova | ADR-0001 ja aprovada |
| 14 | **Integracions i assistent** | #51, #52, #108, #109 | N1 context de l'assistent: prova que falla si surt un camp no consentit; N3 proveïdors de núvol amb simulador i revocació | Proveïdors i consentiment (ADR) |
| 15 | **Xat i POP3** | #110 → #111, #97 | N3 POP3 contra maddy (UIDL, reconnexió, esborrament diferit, sense duplicats després d'un reinici); xat segons l'adaptador aprovat | Dues ADR |
| 16 | **Plataformes i evolució** | #115, #116, #117, #86, #22/#21 | N4 macOS amb un executor (runner) propi per a l'arrencada i un flux de correu; Linux amb `startup:verify` sobre WebKitGTK; registre complet | Cap |

Estat de la iteració 11 (2026-10-11, per delegació):
- **#93:** llista de tots els adjunts amb filtres, cobertura explícita i
  enllaç al missatge, sense índex de contingut (ADR-0020,
  [registre](design/attachments.md)).
- **#43:** constructor de cerques que llegeix i escriu amb la gramàtica del
  nucli (anada i tornada provada), i cerques desades amb el seu compte i
  carpeta (ADR-0021, [registre](design/search-builder.md)).
- **#92:** accions ràpides amb passos segurs (llegir, destacar, arxivar o
  moure al final), conjunt fixat en confirmar, informe per pas i
  Alt+1…9 (ADR-0022, [registre](design/quick-actions.md)).
- **#91:** categories de safata definides per la persona, amb el motiu
  visible, correccions per conversa i remitent que sobreviuen a la
  sincronització, Tot i Altres sempre presents i recomptes amb cobertura
  (ADR-0023, [registre](design/inbox-categories.md)).
- **#95:** inventari d'etiquetes, categories i anotacions per flux,
  amb la seva prova; etiquetar en lot sense sobreescriure altres etiquetes; proves de
  moviment, reinici, aïllament i separació. Exchange i IMAP queden
  pendents d'evidència real ([registre](design/labels-certification.md)).

Estat de la iteració 12 (2026-10-12, per delegació):
- **#89:** una resposta dins del seu període per desfer ja no es perd en
  tancar; dos enviaments simultanis no es donen per enviats; s'avisa que
  cal l'app i dels enviaments endarrerits; els posposats moguts continuen
  visibles (ADR-0024, [registre](design/send-lifecycle.md)).
- **#45:** esperar resposta al que s'ha enviat, amb la resposta reconeguda per
  `In-Reply-To`, conversa i remitent (mai per l'assumpte), dubtes que
  decideix la persona i un recordatori que només avisa dins de l'app
  (ADR-0025, [registre](design/awaiting-replies.md)).
- **#88:** text desat amb cerca, marcadors emplenats des del
  missatge (el que no es pot emplenar es queda i s'avisa) i `{{cursor}}`;
  la sincronització de signatures amb proveïdors queda pendent d'evidència
  real ([registre](design/quicktext-placeholders.md)).
- **#90:** enviaments personalitzats, cada missatge només per al seu destinatari,
  visualització prèvia completa que és exactament el que s'envia, problemes que
  impedeixen enviar, resultat per destinatari, pausa davant dels límits i cap
  reintent a cegues (ADR-0026, [registre](design/personalized-mailings.md)).
- **#94:** inventari per proveïdor i regles al servidor per ManageSieve,
  amb traducció exacta o, si no, la regla sencera es queda aquí, sense sobreescriure còpies
  canviades ni desactivar altres scripts i sense aplicar-la dues vegades. Gmail, EWS i
  Graph queden bloquejats per permisos i evidència
  (ADR-0027, [registre](design/server-rules.md)).

Estat de la iteració 13 (2026-10-12, per delegació):
- **#50:** remitents bloquejats i permesos que decideixen el suggeriment sense
  moure res; pla de regles que és el que s'executa (corregeix accions posteriors a
  «moure» que es mostraven i no es feien); execució sobre el correu
  existent tal com es va revisar, amb informe per pas
  (ADR-0028, [registre](design/spam-lists-and-rule-runs.md)).
- **#49:** OpenPGP i S/MIME comprovats en tots dos sentits contra GnuPG i
  OpenSSL; corregits el `MIME-Version` duplicat, la signatura armada com a missatge i
  els algorismes no compatibles notificats com a danys
  ([registre](design/crypto-interop.md)).
- **#107:** EasyPrivacy fixada amb procedència, aplicada al sanejament del
  nucli (entitats, CSS, `<style>`), recompte visible amb la regla,
  excepció per missatge que pregunta i actualització només a petició i
  comprovada (ADR-0029, [registre](design/tracking-protection.md)).
- **#105:** gramàtica en anglès amb Harper en un worker, sense xarxa, desactivada
  per defecte; suggeriments com una sola edició que conserva el format;
  la font deixa de demanar-se a Google Fonts
  (ADR-0030, [registre](design/offline-grammar.md), [SOUP](soup.md)).
- **#106:** traducció amb Bergamot en un worker; models de Mozilla d'un
  registre fix amb resums (hash), baixats pel nucli només a petició i després de
  veure'n la mida i l'origen, comprovats i col·locats de manera atòmica; al
  lector, amb l'original a un clic; a l'editor, revisada abans de
  fer-la servir (ADR-0031, [registre](design/offline-translation.md)).
- Les proves e2e s'executen ara amb la CSP de producció; així es va veure que
  WebAssembly i els seus workers estaven bloquejats.
- La iteració 13 queda completa en el que és automatitzable; falta N5 (interoperabilitat
  amb Thunderbird/Outlook amb comptes de prova) a la verificació final.

Estat de la iteració 14 (2026-10-12, per delegació):
- **#51/#52 (estable):** l'assistent està desactivat per defecte, i el que es
  revisa és el cos exacte que s'envia, lligat al testimoni. Es corregeixen:
  - el format, que no entenia cap proveïdor real;
  - els cossos d'error que acabaven al registre de diagnòstic;
  - la cancel·lació, que no aturava una petició en curs.

  S'hi afegeix reescriure l'esborrany amb revisió, i hi ha una prova que falla
  si surt un camp no revisat
  (ADR-0032, [registre](design/assistant-consent.md)).
- **#108:** enllaços de només lectura des de Nextcloud i ownCloud, amb destinació,
  progrés, cancel·lació, contrasenya i caducitat. Es respecta el que exigeix el
  servidor, i un enllaç més obert del que s'ha demanat es retira. Dropbox,
  OneDrive i Google Drive queden bloquejats pels registres OAuth
  (ADR-0033, [registre](design/cloud-links.md)).
- **#109:** la reunió va unida al seu esdeveniment: es llegeix del servidor i es
  reconeixen els enllaços de Meet, Zoom, Teams, Webex, Jitsi, GoTo i Whereby
  en qualsevol calendari, amb «Unir-se». Google Meet es crea, es manté i
  es treu només en triar-lo, sense duplicats. Els altres queden bloquejats pels
  seus registres (ADR-0034, [registre](design/online-meetings.md)).
- La iteració 14 queda completa en el que és automatitzable; falten els registres
  OAuth del propietari i N5.

Estat de la iteració 15 (2026-10-12, per delegació):
- **#97:** comptes POP3 que baixen a una Safata d'entrada local, sense
  duplicats (UIDL més resum). Es conserven al servidor tret que es
  triï esborrar, i l'esborrament només és efectiu amb `QUIT`. Provat amb un servidor
  fals i amb Dovecot real a la CI (ADR-0035, [registre](design/pop3.md)).
- **#110/#111:** matriu de proveïdors i decisió: XMPP primer, per ser un
  estàndard obert sense registre ni despesa. Xat directe amb identitat per
  `origin-id`, sense duplicats entre directe, carbons i arxiu. Els estats
  d'enviament només avancen cap endavant i el que és incert no es torna a enviar sol.
  Provat amb Prosody real a la CI. Grups, fitxers i altres proveïdors
  queden pendents (ADR-0036, [registre](design/chat.md)).

Estat de la iteració 16 (2026-10-12, per delegació):
- **#86:** «Historial amb …» al tauler de la conversa: converses,
  reunions properes i fitxers d'aquella persona en aquell compte; cadascun
  obre el seu origen. Coincideix per adreça completa i diu quant
  correu hi ha aquí ([registre](design/contextual-sidebar.md)).
- **#115:** el binari de producció arrenca dues vegades en un perfil nou
  sobre WebKitGTK (Linux) i WKWebView (macOS) amb la CSP de producció, a la
  CI i amb captures de pantalla. L'executor de macOS de GitHub no costa res perquè el
  repositori és públic. Clauer, notificacions, impressió, IME i
  instal·lació signada a macOS continuen sense evidència: calen un Mac i
  la signatura del propietari ([registre](design/desktop-platforms.md)).
- **#116:** inventari mòbil a part. Hi ha correu, OAuth, RSS i còpia de
  seguretat; falten calendari, llibreta de contactes, tasques, notes,
  xifratge, POP3 i xat. L'abast mòbil el decideix el propietari
  ([registre](design/mobile-inventory.md)).
- **#117:** diferències (delta) d'eM Client 11 respecte a Oreneta. Una font secundària
  diu que la 11 ja és estable, però no està confirmat a emclient.com.
  Moure la referència del registre (10.4.5674.0) ho decideix el propietari
  ([registre](design/emclient-11-delta.md)).
- **Registre d'acceptació:** les files del que s'ha lliurat a les iteracions 13 a 16 tenen
  el seu estat i la seva execució en verd de la CI. Cap no passa a `verified`: falta
  l'evidència nativa i de proveïdor de la verificació final.
- **#102, el que queda pendent d'ADR-0019:** proposar una altra hora (COUNTER) des de la
  targeta d'una invitació, i com a organitzador veure la proposta, rebutjar-la
  (DECLINECOUNTER) o obrir-la a l'editor amb l'hora proposada. Desar en
  calendaris locals i CalDAV no avisa els assistents, i així s'indica. L'editor
  i les targetes avisen de les coincidències amb l'agenda pròpia,
  sense xarxa. La disponibilitat d'altres persones des dels servidors queda
  bloquejada (ADR-0043, [registre](design/counter-proposals.md)).
- **#111, el que queda pendent d'ADR-0036:** grups XMPP (MUC): unir-se per
  adreça amb sobrenom i contrasenya al clauer, historial en entrar i
  arxiu de la sala, tornar a entrar en reconnectar, el propi eco sense
  duplicar, el sobrenom de qui parla, sortir, i invitacions que només
  s'ofereixen. Fitxers per HTTP File Upload: límit del servidor abans de
  pujar, només HTTPS, progrés i cancel·lació, i l'enllaç com a OOB; el que es
  rep només es desa quan es demana. Provat amb Prosody real a la CI, amb
  dues persones en una sala i un fitxer per HTTPS
  (ADR-0044, [registre](design/chat.md)).

Criteri de sortida C-C: totes les files obligatòries Windows/proveïdor del registre
`verified`; qualsevol exclusió manté la declaració de **paritat parcial**.

### Mode d'execució acordat el 2026-10-11

El responsable va triar dues coses:
- **Decisions d'arquitectura.** Les que queden les pren l'agent amb
  l'opció més prudent. Cadascuna es registra com a ADR «acceptada per
  delegació», amb les seves alternatives, i el responsable la revisa al final. Només
  es consulta abans el que impliqui despesa, publicar alguna cosa o fer servir dades
  reals.
- **Verificació.** Es mantenen les proves automàtiques a cada canvi (N1 a
  N3 i N6-a11y a la CI). La verificació nativa a Windows (N4) i amb
  proveïdors reals (N5) es fa una sola vegada, sobre la versió final.

Continuen bloquejats fins que el responsable aporti els recursos:
- els registres OAuth propis;
- la signatura de l'aplicació;
- la identitat de Partner Center;
- un equip Windows;
- comptes de prova.

## 5. Estratègia de verificació

### Nivells i què prova cadascun

| Nivell | Què és | Eina | Quan s'executa |
|---|---|---|---|
| **N1 Unitari** | Lògica pura per mòdul: analitzadors, estats, store, contractes d'error | `cargo test`, `go test`, `bun test` | Cada PR |
| **N2 Component i entrada de producció** | UI amb pont simulat: focus, teclat, amplades, temes, zoom, idioma | bun test + Playwright (`startup.e2e.ts`, `baseline/`) | Cada PR |
| **N3 Integració aïllada** | Sidecar real contra servidors locals (maddy, Radicale, simulador Graph, enregistraments EWS) | `go test -tags integration` + informe JSON | Cada PR |
| **N4 Natiu** | Binari real de Windows (i després macOS/Linux): instal·lació, fluxos, recuperació | `windows-validation.yml` + scripts PowerShell | Per iteració i per candidat |
| **N5 Proveïdor real** | Comptes de prova autoritzats: Gmail, Workspace, M365, EWS on-prem | Procediment de `provider-acceptance.md`, evidència al registre | Per candidat |
| **N6 No funcional** | Rendiment 1k/10k/100k, memòria, accessibilitat (axe), contrast | `scripts/perf/`, axe a Playwright, dispositiu de referència | N6-a11y a cada PR; N6-perf per iteració |

### Què vol dir «ben provat» per a una slice

Un PR només es fusiona si compleix tot el que segueix; els pares només es tanquen
quan, a més, hi ha N4/N5 aplicable.

1. **Cada cas d'acceptació de la incidència té una prova amb el seu nom** i la prova
   falla sense el canvi (demostrat al PR quan és una correcció).
2. **Les sis famílies de casos** estan cobertes: èxit, límit, error,
   interrupció/recuperació, aïllament entre comptes i regressió de defectes
   anteriors. Si una família no s'hi aplica, el PR ho diu.
3. **Cap ruta d'escriptura cap a un proveïdor sense prova de resultat
   incert**: desconnexió entre petició i confirmació, reintent i
   desduplicació.
4. **La cobertura per paquet no baixa** respecte a main; una baixada exigeix
   una justificació explícita al PR.
5. **Cap prova s'omet, es desactiva o es marca com a inestable (flaky)** per obtenir el verd;
   una prova inestable es corregeix o s'elimina amb la seva incidència.
6. **Entrada de producció** per a tot canvi visual: 600/1024/1440, clar/fosc,
   castellà i anglès, teclat i zoom del 200 %, amb una captura de pantalla pujada com a artefacte.
7. **Evidència identificada per SHA** al registre: estat real assolit
   (`implemented-unverified`, `partial` o `verified`), mai inferit d'una simulació.

### Infraestructura que falta i ordre de construcció

| Peça | Per què | Iteració |
|---|---|---|
| Cobertura a la CI amb informe per paquet | Per poder exigir que no baixi | 0 |
| Radicale al job `integration` | CalDAV/CardDAV sense compte real; necessari per a #28, #41, #101 | 0 |
| Simulador Graph local amb enregistraments | L'única manera de provar 429/401/continuació de forma repetible; necessari per a #141–#143 | 0 |
| Banc de proves EWS amb enregistraments SOAP | Reproduir sense servidor el que `ews-smoketest.py` fa a mà; necessari per a #46, #48, #102 | 0 |
| Script de fluxos natius a Windows | Passar d'«arrenca» a «funciona»; necessari per a #147 i tot N4 | 0, ampliat a 2, 6, 7, 10 |
| axe a Playwright | Accessibilitat automàtica mínima per a #37 | 0 |
| Corpus de regressió de correu real anonimitzat | HTML ample, rastrejadors, codificacions, adjunts estranys; alimenta l'N1 del lector i de la importació | 5, 10, 13 |
| Dispositiu Windows de referència amb mesures repetides | Calibrar els llindars de #53 i la memòria de #148 | 6 |
| Executor (runner) macOS | N4 per a #115 | 16 |
| Proves Go per a `mail.go`, `oauth.go`, `sidecar.go`, `calendar.go` | Lògica de pont sense prova dedicada avui | 1–2 (correu), 4 (OAuth), 8 (calendari) |
| Proves Rust per a `rss.rs`, `backend.rs`, `thread_list.rs`, `thread_read.rs`, `unified.rs` | Mòduls grans amb 0–5 proves | 5 (llistes), 11 (RSS i unificat) |

### Portes de qualitat

| Porta | Condició |
|---|---|
| **Per PR** | Set suites en verd al SHA exacte, cobertura no inferior, N2 amb captures de pantalla si hi ha canvi visual, revisió tècnica i de producte |
| **Per iteració** | `windows-validation.yml` llançat sobre el commit de fusió final; registre actualitzat; N6-perf registrat si la iteració toca llistes, memòria cau o arrencada |
| **Per candidat** | Files N5 executades amb comptes autoritzats; instal·lació, actualització i recuperació natives; comparació dels fluxos de #32 aplicables; cap fila obligatòria del candidat per sota de `verified` |
| **Per publicar** | Porta de `verify-release.yml` + signatura + decisió humana separada; aquest pla no la concedeix |

## 6. Dependències que només pot resoldre el responsable

Aquestes no es desbloquegen escrivint codi; convé obrir-les ja perquè
condicionen la iteració 6 i les posteriors.

1. **Credencials OAuth pròpies** (Google i Microsoft) per a #144; sense elles no hi ha
   candidat distribuïble amb inici de sessió ni files N5 de Gmail/M365.
2. **Comptes de prova dedicats** per proveïdor (IMAP genèric, Gmail, Workspace,
   M365, EWS on-prem) i autorització escrita d'operacions i destinataris, per a
   #145/#98. Sense ells el registre no pot passar d'`implemented-unverified`.
3. **Equip Windows de referència** per a l'evidència nativa (#147, #148, #181) i
   política de signatura/Application Control; identitat de Partner Center per a #188.
4. **Cinc decisions d'arquitectura** en forma d'ADR abans de la seva iteració:
   tasques completes (#103), notes (#104), perfils (#99), POP3 (#97), xat (#110);
   més proveïdors de núvol/reunions (#108/#109).
5. **Participants del pilot** (#55): protocol a punt a C-A, inscripció a part.
6. **Un servidor Exchange de proves** (o enregistraments autoritzats d'un) per al
   banc de proves EWS de la iteració 0.

## 7. Regles d'execució que es mantenen

- Una slice per PR, amb `Closes #N` només si cobreix tots els criteris; els pares
  queden oberts fins que es compleixi tot.
- Proves d'èxit, límit, error, interrupció, aïllament i regressió; CI del SHA
  exacte abans del commit de fusió; comprovació de main després.
- Actualitzar #22 i #21 en tancar cada iteració, separant implementat, provat
  amb fixtures, verificat natiu i verificat amb proveïdor.
- Res d'aquest pla publica versions, modifica comptes ni contracta serveis.

## 8. Primera acció recomanada

Començar per la **iteració 0** en paral·lel amb **#29** (enviament incert durable).
La iteració 0 és petita per peça i desbloqueja les proves de Graph, de calendari
i natives; #29 és el risc de pèrdua de dades amb més impacte, i #143 i #170
depenen del seu contracte. Obrir alhora les sol·licituds externes de l'apartat 6
perquè la iteració 6 no quedi bloquejada per falta de credencials, comptes o
dispositiu.
