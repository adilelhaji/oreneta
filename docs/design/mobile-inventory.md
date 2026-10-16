# Inventari mòbil (#116)

Oreneta mòbil (`mobile/`) és una aplicació Kotlin Multiplatform per a
Android i iOS. Fa servir el mateix nucli `meron-core` a través del seu protocol
d'ordres. Aquest inventari surt de les ordres que la part compartida
(`mobile/shared/src/commonMain`) envia al nucli. Es compara amb eM Client
per a iOS i per a Android per separat: l'escriptori no demostra res sobre el
mòbil.

| Àrea | Mòbil avui | Seguiment |
|---|---|---|
| Correu IMAP/SMTP, Google i Outlook amb OAuth | Sí: sincronitzar, llegir, enviar, esborranys, moure, arxivar, carpetes, adjunts | Paritat per comprovar al dispositiu |
| Exchange (EWS/Graph) | Només l'intercanvi OAuth d'Outlook; sense bústia Exchange pròpia | Pendent |
| POP3 | No | Pendent |
| Calendari | Interfície llesta: calendaris (mostrar o ocultar), agenda per dies de dues setmanes, detall de l'esdeveniment i crear, editar i esborrar en calendaris amb escriptura. Sense avisar els convidats ni editar sèries. El nucli mòbil atén `calendar.*` amb el codi de l'escriptori (ADR-0045); actualització a petició i periòdica (`pim.refresh`), recordatoris com a notificacions locals i errors de sincronització en un avís | Recordatoris programats per avançat a iOS; proves al dispositiu |
| Contactes | Interfície llesta: llibreta amb cerca, fitxa, escriure a una adreça, i crear, editar i esborrar a la llibreta local i a CardDAV amb escriptura. El nucli mòbil atén `people.*` amb el codi de l'escriptori (ADR-0045); llibretes de Google i CardDAV llegides cada hora i en actualitzar (`pim.refresh`), amb avís si fallen | Permís de contactes a l'OAuth de Google del mòbil; proves al dispositiu |
| Tasques i notes | No | Pendent |
| OpenPGP i S/MIME | No | Pendent |
| Cerca | Parcial: llistes de converses, sense constructor ni cerques desades | Pendent |
| RSS | Sí: fonts, OPML, llegit i destacat | — |
| Còpia de seguretat | Exportar i importar | — |
| Xat | No | Pendent |

## Proposta per delegació

- La paritat declarada és la de l'escriptori per a Windows. El mòbil es mesura
  a part i no entra en una declaració de paritat universal: mentre no
  tingui les seves pròpies proves, la paritat és **parcial**.
- Qualsevol domini mòbil nou (calendari, contactes, xifratge) reutilitza
  les ordres del nucli que ja existeixen a l'escriptori. Una arquitectura
  de plataforma nova necessita la seva pròpia aprovació.
- Les proves són les que ja existeixen (proves comunes de Kotlin, proves
  d'Android a l'amfitrió i fluxos Maestro). Calen proves al dispositiu
  per a cada domini que s'afegeixi.

Decisió del propietari: quins dominis mòbils hi entren i amb quin
pressupost de proves i de manteniment.

## Calendari i contactes (decisió del 2026-10-12)

Decisió del propietari: al mòbil hi entren primer el calendari i els contactes,
amb les mateixes ordres del nucli que fa servir l'escriptori. Sense una
arquitectura de plataforma nova.

- **Ordres.** Calendari: `calendar.list`, `calendar.setEnabled`,
  `calendar.events`, `calendar.eventDetails`, `calendar.create`,
  `calendar.update` i `calendar.delete`, amb els paràmetres que
  `calendar.go` passa al nucli. Contactes: `people.list`, `people.save` i
  `people.delete`, com `people.go`.
- **Límits intencionats.** El mòbil no avisa mai ningú (`notify` sempre
  fals) i només canvia l'ocurrència que es té al davant (`scope`
  `occurrence`). Un esdeveniment amb altres persones, o d'un altre organitzador,
  no s'edita ni s'esborra des del mòbil: s'explica que s'ha de fer des de
  l'escriptori, que sí que els pot avisar. Els calendaris de només lectura i les
  subscripcions no ofereixen canvis. A contactes, només la llibreta local i
  els llibres CardDAV en què el servidor deixa escriure; Google i el directori
  són de només lectura. Un contacte nou va a la llibreta del dispositiu.
- **Al nucli (ADR-0045).** Aquestes deu ordres ja no viuen només al
  `dispatch` del binari d'escriptori (`main.rs`): el seu codi és a la
  biblioteca (`meron-core/src/pim/`), i tant `dispatch` com el pont
  mòbil (`protocol::dispatch_mobile_protocol_request` →
  `protocol/pim.rs`) criden les mateixes funcions, sobre el mateix
  `Engine`. Les respostes i els errors són els de l'escriptori. L'avís
  «aquesta versió encara no obre calendaris ni contactes» queda només per als
  nuclis anteriors que responguin `unknown method`.
- **Sincronització al mòbil.** `calendar.events` amb `refresh` (el que
  fa l'agenda en obrir-se, en canviar de setmana i en tornar a «Avui»)
  actualitza aquella finestra en segon pla a l'entorn d'execució de l'`Engine`,
  igual que a l'escriptori, i avisa amb `calendar.synced` (o
  `calendar.syncError`) pel canal d'esdeveniments; l'agenda torna a llegir la
  memòria cau. Una escriptura en un calendari de compte actualitza la finestra en
  què cau.
- **Sincronització periòdica i recordatoris (`pim.refresh`).** Una ordre
  mòbil nova, sobre `pim::refresh` i `pim::reminders` del nucli:
  - primer lliura els recordatoris vençuts, amb la mateixa consulta i el
    mateix registre de «ja avisat» que el vigilant de l'escriptori
    (ara `spawn_reminder_watch` crida `pim::reminders::take_due`); la
    forma de cadascun és la de l'esdeveniment `calendar.reminder` de l'escriptori;
  - si se li permet (`sync`), llegeix la finestra fixa (d'ahir a d'aquí a cinc
    setmanes) de cada compte amb calendaris remots l'última lectura correcta del
    qual tingui més de 15 minuts, i cada llibreta (Google, CardDAV) amb més
    d'una hora; una fallada no es torna a provar abans del seu interval en aquell
    procés. El que ha vençut es decideix amb `synced_at` i `last_sync_at` del
    magatzem, de manera que una tasca en segon pla en un procés nou decideix igual;
  - crea la llibreta de cada compte de Google (`google-<compte>`), com fa
    l'escriptori quan es prem «Sincronitza els contactes de Google».
  En primer pla, `MeronApp` la crida cada minut (només recordatoris) i
  cada 15 minuts amb lectura; a iOS la lectura segueix la regla de les
  comprovacions automàtiques del correu (interval «Desactivat» = sense
  xarxa). En segon pla va darrere del correu al `WorkManager` d'Android i al
  `BGAppRefreshTask` d'iOS, que publiquen ells mateixos els recordatoris de la
  resposta. Les notificacions surten pel camí existent: un canal propi a Android
  (`meron_calendar_reminders`) i `UNUserNotificationCenter` a iOS, que també les
  mostra amb l'aplicació oberta. L'escriptori no té sincronització periòdica del
  calendari ni de les llibretes (actualitza en obrir una visualització o quan es
  demana) i continua igual.
- **Errors visibles.** `calendar.syncError` i les fallades de llibretes de
  `pim.refresh` es mostren com un avís no bloquejant a Calendari i a
  Contactes (per compte o llibreta; una lectura correcta l'esborra). El botó
  d'actualitzar de Contactes també llegeix les llibretes.
- **Pendent.** Des del mòbil no es poden afegir calendaris CalDAV,
  subscripcions ni llibretes CardDAV, i les seves contrasenyes viuen al clauer
  de l'escriptori. Exchange no té cap llibreta per sincronitzar ni a l'escriptori
  (només la cerca al directori), i el mòbil no té bústia Exchange
  pròpia. L'OAuth de Google del mòbil només demana correu i perfil (sense
  `auth/calendar` ni `contacts.readonly`): el calendari i la llibreta d'un
  compte de Google fallen, i les pantalles ho diuen amb un avís propi
  («l'inici de sessió de Google de l'aplicació no demana aquest accés»), perquè
  tornar a connectar no serveix de res. Cal que el propietari afegeixi aquests
  permisos a la pantalla de consentiment i al client OAuth del mòbil (navegador i
  `GoogleAccountManagerAuth`) i que es torni a connectar el compte; aquest
  canvi no toca els permisos. Els recordatoris es lliuren quan arriba la seva
  hora, no es programen per avançat: amb l'aplicació suspesa a iOS, un pot
  arribar tard, o perdre's si el sistema no executa la tasca en segon pla abans
  que comenci l'esdeveniment. A la pràctica, avui funcionen la llibreta local
  i els calendaris locals (amb els seus recordatoris): com que un telèfon acabat
  d'instal·lar no en té cap, la finestra *Calendaris* permet crear-ne un
  (`calendar.createLocal`, la mateixa ordre de l'escriptori), que queda sota
  el primer compte de correu.
- **Proves.** Comunes de Kotlin: `CalendarCommandsTest` i
  `PeopleCommandsTest` (lectura de respostes i forma exacta de cada
  petició, comparada amb el que envia l'escriptori), `CalendarAgendaTest`
  (finestra per dies locals, agrupació, dies sencers, regles d'escriptura
  i de convidats, peticions de desar i d'esborrar), `ContactsModelTest` i
  `PimRoutesTest`. Al nucli: `mobile_calendar_commands_run_the_shared_core`
  i `mobile_people_commands_run_the_shared_core` (per l'entrada mòbil, amb
  els paràmetres de Kotlin), `calendar_refresh_reports_over_the_event_channel`
  i `mobile_pim_refresh_raises_reminders_and_routes_book_sync`; les de
  `pim::reminders` i `pim::refresh`, i al binari
  `the_reminder_watch_uses_the_shared_reminders`. Kotlin: `PimRefreshTest`
  (compartit) i `PimSyncModelTest` (interfície).
  Falten les proves al dispositiu (Maestro).
