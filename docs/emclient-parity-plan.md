# Pla de lliurament de paritat amb eM Client

**Revisió d'execució: 2026-10-05.** El [pla de lliurament competitiu](competitive-delivery-plan.md)
i l'[auditoria de 65 incidències](competitive-backlog-audit.md) substitueixen la instantània inicial
de planificació/estat que hi ha a continuació. Conserven tot aquest abast de capacitats i totes les portes d'arquitectura.
Els temes, els valors per defecte i la disposició estreta estan integrats, Graph continua sent de només lectura i deu
incidències filles acotades cobreixen ara les mancances de lliurament. La planificació no és evidència de paritat.

Data: 2026-09-09. Creades: 13 fites, 35 incidències noves; 34 incidències existents
reutilitzades, inclòs el programa; 2 tancades sense esborrar l'historial.

Programa: [#21](https://github.com/adilelhaji/oreneta/issues/21).
Inventari d'execució: [manifest del backlog](emclient-parity-backlog.json).
Casos d'acceptació i evidència actual: [registre versionat](emclient-parity-acceptance.md).
Això substitueix la **planificació i l'abast** de l'antic pla de pilot intern, no els seus
requisits de seguretat no resolts. La planificació no aprova arquitectura nova.

## Objectiu i formulació honesta de la finalització

La primera referència congelada és **eM Client 10.4.5674.0 per a Windows**, publicada
el 2026-08-14. La més recent, **11.0.282.0 (2026-09-03), és beta** i se'n fa el seguiment per separat.
Font: [historial oficial de versions per a Windows](https://www.emclient.com/release-history?os=win).
En cada límit de sprint, comparar els canvis amb la referència; versionar la matriu
i registrar les diferències en incidències, en lloc de moure en silenci la meta del sprint en curs.

Lliurar **resultats per a l'usuari i qualitat d'interacció** comparables, no codi
font propietari, marca, recursos gràfics, infraestructura ni el mateix motor de renderització.
Mantenir la identitat cobalt/navy acceptada d'Oreneta i la pila nativa Wails/Go/Rust/React.
Una implementació interna diferent només és acceptable si el comportament observable
externament i les limitacions es proven i es documenten explícitament.

Primera declaració d'acceptació: «paritat d'escriptori a Windows respecte a la matriu congelada».
L'escriptori macOS necessita la seva pròpia evidència nativa. Linux continua cobert per les
obligacions de regressió existents d'Oreneta. El mòbil és una matriu de producte/plataforma diferent;
aquest pla no autoritza una arquitectura mòbil nova ni afirma una paritat universal.
Les funcions de pagament d'eM continuen en la comparació, encara que Oreneta les ofereixi de manera diferent.
Els serveis allotjats específics d'un fabricant necessiten un equivalent o una decisió documentats; ometre'n
un no esdevé «paritat completa». Un rebuig d'arquitectura o un ajornament aprovat
implica **paritat parcial**, amb la mancança restant visible.

## Evidència inicial històrica (2026-09-09), no finalització actual

Línia de base d'aquest pla: la branca main remota
`100976d423258eb302bcc903c9c059838666e40c` (PR #82).
La [línia de base històrica](baseline.md) recull evidència més antiga i no s'ha de llegir com
el registre actual de finalització.

- El PR #81 va lliurar una referència sintètica navegable, no un client de correu real.
- El PR #82 va integrar la navegació real per comptes/carpetes per sobre de 1024px, no el redisseny complet.
- Els valors per defecte de producció encara fan servir Indigo, targetes i converses d'estil xat.
- El defecte del lector fora de pantalla a 600px continua caracteritzat, no corregit.
- IMAP/SMTP/MIME, EWS, contactes, tasques locals enllaçades i criptografia tenen implementació;
  la garantia independent per proveïdor/plataforma nativa continua incompleta.
- Els commits locals d'adjunts/plantilles `7427383`, `142a007`, `f4d19e9` continuen a
  la branca main local de l'usuari. #40 els ha de reconciliar sense descartar canvis ni
  comptar-los com a lliurats abans d'un PR revisat i una CI en verd.
- L'executable de Windows existent és anterior a #81/#82; aquest canvi de planificació
  no produeix cap executable nou.

Vocabulari d'estat per capacitat/plataforma/proveïdor: **unassessed**, **absent**,
**partial**, **implemented-unverified**, **verified**, **blocked**. Només l'estat verified
compta per a la paritat. Una simulació, una captura de pantalla, un PR fusionat o un binari compilat,
per si sols, no poden acreditar una capacitat sencera. No s'ha d'inferir absència només a partir d'una cerca.

## Matriu de capacitats traçable

La incidència responsable ha de concretar cada fila en casos d'acceptació versionats, citant
el comportament de referència, els punts d'entrada del codi, els límits del proveïdor i el SHA de l'evidència.
Aquest és l'inventari complet de línies de treball, no una afirmació que cada microfunció
ja s'hagi analitzat per enginyeria inversa. #22 és responsable de l'auditoria de configuració/menús/proveïdors;
els requisits descoberts de nou han de tenir una incidència abans que s'accepti el registre.

| Capacitat | Resultats requerits | Incidències responsables | Estat actual |
|---|---|---|---|
| C01: Identitat i disseny compartit | Temes cobalt, tokens semàntics, tipografia, icones, menús, formularis, contrast, sense deriva decorativa | [#8](https://github.com/adilelhaji/oreneta/issues/8) → [#33](https://github.com/adilelhaji/oreneta/issues/33); [#83](https://github.com/adilelhaji/oreneta/issues/83) | partial |
| C02: Espai de treball de correu | Llista/lector inicials convencionals, panells persistents, densitat, teclat, comportament en amplada estreta/zoom | [#32](https://github.com/adilelhaji/oreneta/issues/32), [#33](https://github.com/adilelhaji/oreneta/issues/33), [#34](https://github.com/adilelhaji/oreneta/issues/34), [#35](https://github.com/adilelhaji/oreneta/issues/35), [#36](https://github.com/adilelhaji/oreneta/issues/36); [#84](https://github.com/adilelhaji/oreneta/issues/84); [#85](https://github.com/adilelhaji/oreneta/issues/85) | partial |
| C03: Operacions amb carpetes | Jerarquia real, preferits, colors, gestió, moviments i seleccions segurs | [#27](https://github.com/adilelhaji/oreneta/issues/27), [#34](https://github.com/adilelhaji/oreneta/issues/34); [#87](https://github.com/adilelhaji/oreneta/issues/87) | partial |
| C04: Lector | HTML/text pla, citacions, imatges, accions per missatge, zoom del cos i impressió acotada | [#35](https://github.com/adilelhaji/oreneta/issues/35) | partial |
| C05: Context | Agenda, invitacions, historial de comunicacions/fitxers del contacte amb origen i cobertura | [#86](https://github.com/adilelhaji/oreneta/issues/86) | unassessed |
| C06: Llistes | Ordenació global, paginació estable, columnes configurables, disposició desada i semàntica de selecció | [#30](https://github.com/adilelhaji/oreneta/issues/30), [#36](https://github.com/adilelhaji/oreneta/issues/36) | partial |
| C07: Redacció | Compte/àlies, destinataris, text enriquit/taules/imatges, correcció ortogràfica, esborranys, adjunts i recuperació | [#39](https://github.com/adilelhaji/oreneta/issues/39), [#40](https://github.com/adilelhaji/oreneta/issues/40); [#88](https://github.com/adilelhaji/oreneta/issues/88) | partial |
| C08: Enviament | Resultats acceptats versus desconeguts, arxivament a Enviats, planificació, retard per desfer i seguiment | [#29](https://github.com/adilelhaji/oreneta/issues/29), [#45](https://github.com/adilelhaji/oreneta/issues/45); [#89](https://github.com/adilelhaji/oreneta/issues/89) | partial |
| C09: Correu personalitzat | Missatges específics per destinatari revisats i resultats parcials exactes | [#90](https://github.com/adilelhaji/oreneta/issues/90) | unassessed |
| C10: Cerca | Operadors, filtres visuals, àmbits de compte/carpeta, vistes dinàmiques desades i cobertura parcial | [#31](https://github.com/adilelhaji/oreneta/issues/31), [#43](https://github.com/adilelhaji/oreneta/issues/43) | partial |
| C11: Classificació | Categories, etiquetes locals/remotes, marques, anotacions de missatges, accions reversibles | [#91](https://github.com/adilelhaji/oreneta/issues/91); [#95](https://github.com/adilelhaji/oreneta/issues/95) | unassessed |
| C12: Automatització | Regles locals/de servidor, correcció de correu brossa, macros, respostes d'absència/reenviament on s'admetin | [#48](https://github.com/adilelhaji/oreneta/issues/48), [#50](https://github.com/adilelhaji/oreneta/issues/50); [#92](https://github.com/adilelhaji/oreneta/issues/92); [#94](https://github.com/adilelhaji/oreneta/issues/94) | partial |
| C13: Fitxers | Cerca de tots els adjunts, previsualitzacions, enllaços per desar/a l'origen, indexació acotada | [#40](https://github.com/adilelhaji/oreneta/issues/40); [#93](https://github.com/adilelhaji/oreneta/issues/93) | partial |
| C14: Comptes | Descobriment a partir de l'adreça de correu, recuperació OAuth/manual, visualització de les capacitats del servei, grups/perfils | [#96](https://github.com/adilelhaji/oreneta/issues/96); [#99](https://github.com/adilelhaji/oreneta/issues/99) | partial |
| C15: Protocols/proveïdors | IMAP/SMTP, POP3, Gmail/Workspace, Outlook/M365, EWS local (on-prem), iCloud i variants de servei llistades | [#46](https://github.com/adilelhaji/oreneta/issues/46), [#47](https://github.com/adilelhaji/oreneta/issues/47), [#48](https://github.com/adilelhaji/oreneta/issues/48); [#97](https://github.com/adilelhaji/oreneta/issues/97); [#98](https://github.com/adilelhaji/oreneta/issues/98) | partial |
| C16: Calendari | Vistes/edició, recurrència, zones horàries, sincronització, subscripcions, recordatoris i cerca | [#100](https://github.com/adilelhaji/oreneta/issues/100); [#101](https://github.com/adilelhaji/oreneta/issues/101) | partial |
| C17: Planificació de reunions | Invitacions/actualitzacions/cancel·lacions, disponibilitat lliure/ocupat, comportament delegat i de només lectura | [#102](https://github.com/adilelhaji/oreneta/issues/102) | unassessed |
| C18: Persones | Camps detallats, grups, desduplicació segura, edició, importació/exportació, procedència/historial | [#28](https://github.com/adilelhaji/oreneta/issues/28), [#41](https://github.com/adilelhaji/oreneta/issues/41); [#86](https://github.com/adilelhaji/oreneta/issues/86) | partial |
| C19: Tasques | Recuperació de les tasques enllaçades existents més llistes independents, recurrència, recordatoris, delegació i sincronització | [#42](https://github.com/adilelhaji/oreneta/issues/42); [#103](https://github.com/adilelhaji/oreneta/issues/103) | partial |
| C20: Notes | Notes enriquides independents, etiquetes/fitxers/cerca, sincronització local i amb servidors compatibles | [#104](https://github.com/adilelhaji/oreneta/issues/104) | unassessed |
| C21: Criptografia | Signatura/xifratge/desxifratge, política d'importació/exportació/descobriment de claus i estats de confiança veraços | [#9](https://github.com/adilelhaji/oreneta/issues/9), [#12](https://github.com/adilelhaji/oreneta/issues/12), [#49](https://github.com/adilelhaji/oreneta/issues/49) | partial |
| C22: Privadesa | Aïllament del contingut no segur, bloqueig de rastrejadors, secrets, consentiment i emmascarament de dades als diagnòstics | [#54](https://github.com/adilelhaji/oreneta/issues/54); [#107](https://github.com/adilelhaji/oreneta/issues/107) | partial |
| C23: Idioma | Gramàtica i traducció fora de línia, cobertura lingüística honesta i models empaquetats | [#105](https://github.com/adilelhaji/oreneta/issues/105); [#106](https://github.com/adilelhaji/oreneta/issues/106) | unassessed |
| C24: Assistent | Generació amb context explícit, revisió/to, resum i extracció revisada, sense accions autònomes sobre el correu | [#51](https://github.com/adilelhaji/oreneta/issues/51), [#52](https://github.com/adilelhaji/oreneta/issues/52) | partial |
| C25: Integracions | Compartició al núvol i cicle de vida de reunions en tot l'inventari de proveïdors publicat | [#108](https://github.com/adilelhaji/oreneta/issues/108); [#109](https://github.com/adilelhaji/oreneta/issues/109) | unassessed |
| C26: Xat | Xat directe/de grup/de canal, presència/historial/fitxers admesos i aïllament entre comptes | [#110](https://github.com/adilelhaji/oreneta/issues/110); [#111](https://github.com/adilelhaji/oreneta/issues/111) | unassessed |
| C27: Portabilitat | Importacions de clients antics, exportacions estàndard, arxius/fitxers de dades locals, perfils i còpies de seguretat completes programades | [#25](https://github.com/adilelhaji/oreneta/issues/25); [#112](https://github.com/adilelhaji/oreneta/issues/112); [#113](https://github.com/adilelhaji/oreneta/issues/113) | unassessed |
| C28: Operacions d'escriptori | Notificacions, dreceres, tàctil, mailto/aplicació predeterminada, servidor intermediari (proxy)/TLS, impressió, DPI/IME, instal·lació/actualització/recuperació | [#37](https://github.com/adilelhaji/oreneta/issues/37); [#114](https://github.com/adilelhaji/oreneta/issues/114); [#115](https://github.com/adilelhaji/oreneta/issues/115) | partial |
| C29: Finalització | Rendiment, accessibilitat, proves extrem a extrem (E2E) natives, artefactes actuals, limitacions restants i suport | [#37](https://github.com/adilelhaji/oreneta/issues/37), [#53](https://github.com/adilelhaji/oreneta/issues/53), [#54](https://github.com/adilelhaji/oreneta/issues/54), [#55](https://github.com/adilelhaji/oreneta/issues/55); [#114](https://github.com/adilelhaji/oreneta/issues/114); [#115](https://github.com/adilelhaji/oreneta/issues/115) | partial |
| C30: Diferències de versions posteriors/plataformes | Beta v11 i mòbil amb abast i proves separats | [#117](https://github.com/adilelhaji/oreneta/issues/117); [#116](https://github.com/adilelhaji/oreneta/issues/116) | unassessed |

Fonts de referència (consultades el 2026-09-09): [visió general](https://www.emclient.com/features-overview),
[correu](https://www.emclient.com/features-email),
[calendari/tasques](https://www.emclient.com/features-calendar),
[contactes](https://www.emclient.com/features-contacts),
[notes](https://www.emclient.com/features-notes),
[xat](https://www.emclient.com/features-chat),
[serveis de correu](https://www.emclient.com/email-services),
[emmagatzematge al núvol](https://www.emclient.com/cloud-storages),
[proveïdors de reunions](https://www.emclient.com/online-meetings-tools).
Les pàgines comercials poden barrejar versions; cal contrastar els elements incerts amb les notes
de versió estables i la configuració abans de marcar una capacitat com a obligatòria per a 10.4.
Les opcions de configuració específiques de proveïdor o menys destacades (temps meteorològic, dreceres, sons, signatures,
variants d'arxivament/importació, descobriment de claus, capacitats de tasques) continuen com a files
d'auditoria explícites a #22; no poden desaparèixer darrere d'una casella genèrica de finalització «altres».

## Full de ruta per sprints i ordre de dependències

Les fites de GitHub són contenidors funcionals de línies de treball. La revisió del 2026-10-05
fa servir les portes de lliurament R0–R4; les slices d'implementació de S01 ja s'han integrat, però l'acceptació completa
continua oberta. S02–S12 són backlogs ordenats, **no promeses d'un sprint cadascun**.
S13 és una cua de descobriment separada. Fer servir períodes d'execució de dues setmanes quan es conegui
la capacitat; dividir una fita gran en iteracions acotades en lloc de precipitar
una èpica multiproveïdor en un sol PR. Sense responsables, velocitat ni dates límit inventats.

| Sprint | Resultat | Entrada / sortida |
|---|---|---|
| [S01](https://github.com/adilelhaji/oreneta/milestone/1) | Primer canvi visual real | #22 + theme, mail-default, narrow; aplicació real en clar/fosc, preferències antigues intactes |
| [S02](https://github.com/adilelhaji/oreneta/milestone/2) | Contractes d'integritat i recuperació | Reproduir #27–#29; aprovar només les decisions necessàries de #24/#25; els casos de fallada passen |
| [S03](https://github.com/adilelhaji/oreneta/milestone/3) | Entorn de correu i lector complets | #30, #32–#36, carpetes/barra lateral; flux de treball complet i real, no només el prototip |
| [S04](https://github.com/adilelhaji/oreneta/milestone/4) | Redacció i enviament fiable | #39/#40/#45, biblioteques, planificació i combinació de correspondència; esborranys restaurats i resultats exactes |
| [S05](https://github.com/adilelhaji/oreneta/milestone/5) | Organització i cerca | #31/#43/#50, categories/regles locals/macros/etiquetes/fitxers; abast complet de les consultes i modificacions segures |
| [S06](https://github.com/adilelhaji/oreneta/milestone/6) | Continuïtat de comptes/proveïdors | #46–#48, incorporació/perfils/POP3/certificació de proveïdors; adaptadors aprovats i evidència |
| [S07](https://github.com/adilelhaji/oreneta/milestone/7) | Calendari | Vistes, recurrència, sincronització amb proveïdors i invitacions verificades d'extrem a extrem |
| [S08](https://github.com/adilelhaji/oreneta/milestone/8) | Informació personal | #28/#38/#41/#42, tasques i notes completes; aprovar primer els canvis de model |
| [S09](https://github.com/adilelhaji/oreneta/milestone/9) | Seguretat/idiomes | #9/#12/#49 més les eines d'ADR-0001; proves independents de criptografia i privadesa |
| [S10](https://github.com/adilelhaji/oreneta/milestone/10) | Integracions/assistent/xat | #51/#52, núvol/reunions/xat; consentiment, aïllament i acceptació específica per proveïdor |
| [S11](https://github.com/adilelhaji/oreneta/milestone/11) | Acceptació completa a Windows | #25/#53/#54, migració/còpia de seguretat/artefactes nadius de Windows; totes les files estables de Windows verificades |
| [S12](https://github.com/adilelhaji/oreneta/milestone/12) | Escriptori multiplataforma | #37/#55 i macOS; evidència nativa i acceptació controlada; cap desplegament públic automàtic |
| [S13](https://github.com/adilelhaji/oreneta/milestone/13) | Descobriment de beta/mòbil | Registrar diferències i decisions independentment de la porta estable d'escriptori |

Les dependències són per capacitat, no requisits previs rígids en cascada:
el descobriment de continuïtat d'Exchange de #46 comença immediatament; #9/#12 i qualsevol
problema P0 reproduït d'integritat/seguretat poden passar per davant de S01. Les comprovacions de #37/#53/#54 s'apliquen a cada
lliurament encara que les seves fites de tancament siguin posteriors. El descobriment d'arquitectura de calendari/tasques/notes/xat
s'ha de fer prou aviat per evitar que la implementació quedi aturada.
El manifest separa les `relatedIssues` no bloquejants de les dependències estrictes `blockedBy`.
L'aprovació d'arquitectura és una porta separada; un disseny aprovat no
requereix que es tanqui tota la seva incidència paraigua. Les regles de servidor dels proveïdors que falten
es planifiquen a S06, després de validar les capacitats delegades/de servidor, no a S05.
Cada element té URL d'incidència, sprint, estat inicial i declaració d'evidència;
`unassessed` intencionadament no és una afirmació d'absència ni d'implementació.

### Slices d'execució històriques de S01 (implementació lliurada; acceptació completa oberta)

1. **[#22](https://github.com/adilelhaji/oreneta/issues/22), registre d'acceptació** (S): auditar els valors per defecte actuals i la referència, identificar el SHA exacte
   de la línia de base, les captures de pantalla i les mancances pendents; no exigir el reclutament d'un pilot.
2. **[#83: theme](https://github.com/adilelhaji/oreneta/issues/83)** (M): implementar el valor per defecte documentat per a perfils nous, preservar les eleccions
   persistides i els temes personalitzats, provar clar/fosc/sistema i actualització/reinici.
3. **[#84: mail-default](https://github.com/adilelhaji/oreneta/issues/84)** (M): reutilitzar els modes convencionals admesos, preservar les seleccions
   antigues explícites, oferir un canvi deliberat; provar lectura/resposta i selecció massiva.
4. **[#85: narrow](https://github.com/adilelhaji/oreneta/issues/85)** (S/M): reproduir el tall a 600px, corregir la condició de disposició compartida i
   provar amplades adjacents/zoom sense emmascarar altres fallades del lector.

Les mides només són relatives: S = un sol aspecte acotat, M = diverses interaccions entre components
existents, L = dividir abans d'implementar; les èpiques d'arquitectura/proveïdor queden
sense estimar fins al descobriment. Per al primer període, comprometre només les slices preparades que
càpiguen en la capacitat mesurada; les que es traslladin continuen obertes. No s'afirma cap finalització en 26 setmanes.

Paquet d'acceptació de S01: PR + SHA realment provat + enllaços als resultats automatitzats +
captures de pantalla des de l'entrada de producció a 1440/1024/600 i a les amplades límit, clar/fosc +
comprovacions de migració de preferències/reinici. Cal una verificació nativa a Windows per separat
abans de presentar un executable acabat de compilar com l'actualització validada.
S01 no tanca tota l'èpica de disseny ni afirma paritat funcional.

## Cua de decisions d'arquitectura

| Porta | Decisió requerida abans de la implementació afectada |
|---|---|
| #24 / #25 | Canvis d'identitat, compatibilitat del format de transmissió, propietat durable, migracions i contractes de recuperació |
| #46 → #125 → #127/#128; #47 delegació | Direcció de Graph aprovada a [ADR-0004](adr/0004-microsoft-graph.md) el 2026-09-09; adaptador natiu incremental, adopció explícita per compte, es conserven IMAP/SMTP/EWS locals. Contractes exactes de cada slice documentats abans del codi; l'exposició i l'acceptació per proveïdor continuen obertes. |
| pop3 / profiles | Retenció/identitat de POP3 i aïllament de perfils si falten als contractes actuals |
| tasks-full | Les tasques independents/sincronitzades entren en conflicte amb el contracte actual, local i d'una tasca oberta per fil |
| notes | Emmagatzematge, identitat i semàntica de proveïdors amb notes per a notes independents |
| chat-design → chat | Límit de l'adaptador natiu, historial/presència/fitxers, àmbits i manteniment |
| #51, #52, cloud, meetings | Destinacions externes, consentiment, credencials, retenció/cost i API admeses; el límit de proveïdor/context de #51 i el contracte de revisió de resultats de #52 es van acceptar a [ADR-0006](adr/0006-assistant-provider-context-privacy.md) i [ADR-0007](adr/0007-assistant-results-review-and-cancellation.md) el 2026-09-10 |
| migration / backup | Recuperació completa local xifrada del perfil aprovada el 2026-10-05 a [ADR-0010](adr/0010-full-profile-local-recovery.md), que amplia només el límit d'ADR-0008 de còpia exclusiva de la configuració. L'emmagatzematge d'esborranys #169 està lliurat; queden pendents la integració de l'editor #170, la captura #171, la restauració aïllada #172 i la programació #173. #113 continua oberta; l'aprovació no és acceptació de la còpia completa ni de la recuperació nativa. |
| beta-delta / mobile-scope | Servei de sincronització nou, MCP/Matrix o arquitectura de plataforma nova |

El descobriment pot produir opcions i proves, no triar una arquitectura en silenci.
Quan es trobi una decisió necessària: aturar la implementació afectada, fer a la
persona una pregunta concreta i documentar l'aprovació en un ADR **abans** d'escriure codi.
Els ADR-0001/0002/0003 existents continuen sent vinculants. La funcionalitat de gramàtica/traducció/rastrejadors
ja té una direcció acceptada; no s'ha de reobrir ni introduir una drecera al núvol.
La creació d'aquestes incidències no autoritza subscripcions a serveis, préstec de credencials, desplegament a producció
ni publicació pública.

## Flux de treball de les incidències i definició d'acabat

- Actualitzar main; reconciliar la incidència, el codi actual, la documentació i el treball local abans de programar.
- Acotar una slice revisable; les èpiques mare només es tanquen quan passen tots els requisits fills.
- Actualitzar la documentació concisa amb el codi; la documentació d'arquitectura va primer.
- Les proves cobreixen èxit, límits, errors, interrupció/recuperació, aïllament i
  regressions. Afegir proves d'integració amb proveïdors i E2E natives quan escaigui.
- Revisors lleugers de lògica i de negoci revisen de manera independent cada implementació;
  resoldre les observacions, obrir el PR, exigir comprovacions en verd per al SHA lliurat, fusionar amb
  un **merge commit** i agafar la següent incidència preparada sense una altra sol·licitud de permís.
- Els canvis d'infraestructura/compilació són treball declaratiu de CI/CD. La validació no és
  permís per publicar ni per enviar correu real.
- Adjuntar evidència en captures de pantalla de la UI de producció per als canvis visuals; l'evidència del pont simulat
  es marca com a sintètica i no pot substituir les proves natives/de proveïdor.
- Una porta de publicació inclou SHA del codi font, sumes de verificació, política de signatura/procedència, instal·lació,
  actualització, reversió/recuperació i limitacions conegudes. Retirar els binaris locals antics només
  després que el substitut canònic superi la validació, segons AGENTS.md.

Un element només és verificat quan hi ha enllaçats els casos d'acceptació, les proves, la documentació, les revisions, la fusió
i l'evidència nativa/de proveïdor aplicable. «Ajornat», els comptes de prova inaccessibles,
els dispositius que falten, els defectes no resolts i els serveis no disponibles
continuen sent mancances, no proves superades. No prometre mai zero errors en producció.

## Política de neteja del backlog i disposició

Inventari: 36 incidències obertes, cap PR ni fita oberts en iniciar la planificació.
Reutilitzar #21 com a paraigua de paritat i #22 com a registre d'acceptació.
Conservar les altres 32 incidències d'execució rellevants: seguretat, rendiment, migració,
accessibilitat i evidència de publicació són requisits previs, no treball no relacionat.

- **#8**: consolidar el seu enllaç pendent a la documentació del catàleg de disseny a
  #33 i després tancar-la com a no planificada/duplicada, explícitament **no implementada**.
- **#44**: tancar-la com a no planificada per a aquest abast: l'agrupació opcional per persones/serveis
  no és el mateix que les categories de safata d'entrada d'eM. Preservar la incidència/l'historial i el codi
  existent; la incidència de categories és responsable del requisit real de paritat.
- **#38**: conservar les pantalles de paritat; excloure noves millores específiques de Kanban.
  El comportament existent de Kanban/RSS/mòbil continua protegit contra regressions, no s'elimina.
- **#55**: conservar el suport i l'evidència d'acceptació; la inscripció real de participants i
  el desplegament públic continuen requerint autorització separada.
- **#9**: reparar el cos buit amb el requisit de seguretat del títol, el treball de reproducció
  i proves independents; no tancar un error de criptografia com a no relacionat.

Cap eliminació permanent d'incidències, cap eliminació de codi/dades ni cap tancament de troballes
de seguretat no resoltes. Cada tancament registra el motiu/substitut abans de tancar.
L'antic calendari E0–E8 i les sol·licituds de permís repetides del text de les incidències antigues
queden substituïts per aquest pla i pel flux de treball actual autoritzat per l'usuari; les restriccions
d'acceptació i d'arquitectura es mantenen tret que es reconciliïn explícitament a la incidència.
