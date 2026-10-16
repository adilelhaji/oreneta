# ADR-0045: Calendari i contactes del mòbil al nucli compartit

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-12.
- Abast: les deu ordres que fa servir la interfície mòbil de calendari i
  contactes (`calendar.list`, `calendar.setEnabled`, `calendar.events`,
  `calendar.eventDetails`, `calendar.create`, `calendar.update`,
  `calendar.delete`, `people.list`, `people.save`, `people.delete`), després
  de la decisió del propietari del 2026-10-12 de portar calendari i
  contactes al mòbil reutilitzant el nucli de l'escriptori
  (`docs/design/mobile-inventory.md`). Cap altra ordre (invitacions,
  tasques, notes…) no canvia.

## Decisió

- **Un sol codi per als dos.** La lògica d'aquestes ordres surt del
  `dispatch` del binari d'escriptori (`meron-core/src/main.rs`) cap a la
  biblioteca, a `meron-core/src/pim/`:
  - `pim::calendar`: `list`, `set_enabled`, `events`, `event_details`,
    `create`, `update`, `delete`, i el que necessiten (`local_calendar_write`,
    `caldav_target`, `caldav_write`, `CALDAV_CONFLICT`, `spawn_sync` i la
    sincronització d'una finestra);
  - `pim::people`: `list`, `save`, `delete`, i l'escriptura CardDAV i a la
    llibreta local (`carddav_create` i companyia, `PersonInput`);
  - cada funció rep l'`Engine` i els paràmetres de la petició i
    retorna el JSON que l'amfitrió reenvia sense tocar-lo.
- **L'escriptori no canvia.** Els braços de `dispatch` passen a ser una
  crida a aquestes funcions. Respostes, errors i esdeveniments són els mateixos
  byte a byte; les proves del distribuïdor continuen igual.
- **Esdeveniments de fons amb una abstracció mínima.** El que acaba després
  de respondre (el refrescament d'una finestra) avisa per `pim::Emit`, una
  funció `(nombre, detalle)` asíncrona:
  - a l'escriptori escriu `{"event", "detail"}` a stdout, com la resta
    d'esdeveniments (`emitter` a `main.rs`);
  - al mòbil crida `ffi::emit_event`, el canal d'esdeveniments de la
    plataforma.
- **El reintent de fons passa a la biblioteca.** `is_transient_sync_error`,
  `BackgroundSyncCancelled` i el reintent únic
  (`engine::retry_background_sync_after`) es mouen a `engine.rs`; el
  binari conserva `retry_background_sync` com a embolcall amb el seu propi
  retard, de manera que les seves altres sincronitzacions no canvien.
- **Ruta mòbil.** `protocol::dispatch_mobile_protocol_request` envia aquests
  deu mètodes a `protocol/pim.rs`, que pren l'`Engine` amb
  `ffi::engine_for` (el de primer pla, o un de transitori), aplica la
  mateixa protecció de Graph que l'escriptori i executa la funció compartida
  amb `ffi::engine_block_on`. Els paràmetres són els de l'escriptori
  (`account`, `calendar`, `event`, `change_key`, `series`, `scope`,
  `notify`, `query`, `limit`, `id`, `version`, `book`, `person`); el
  codi Kotlin ja els enviava així i no canvia.
- **Sincronització al mòbil: refrescament a petició.** `calendar.events` amb
  `refresh` (i una escriptura en un calendari de compte) llança el
  refrescament de la finestra al runtime de l'`Engine`, que continua després
  de respondre i avisa amb `calendar.synced` o `calendar.syncError`.
- **Ampliació del 2026-10-13: refrescament periòdic, llibretes i
  recordatoris.** Una ordre mòbil més, `pim.refresh`
  (`meron-core/src/pim/refresh.rs`), i tres que ja tenia l'escriptori
  (`google.contacts.sync`, `carddav.sync`, `carddav.list`), amb la seva lògica
  moguda de `main.rs` a `pim::people` (`sync_source`, `google_sync`,
  `source_sync`, `sources`); els braços de l'escriptori les criden i
  responen igual.
  - **Recordatoris compartits.** `pim::reminders::take_due` decideix quins
    recordatoris han vençut (`calendar::reminders::due`, ADR-0056) i els marca
    com a donats abans de retornar-los, amb la forma de l'esdeveniment
    `calendar.reminder`. El vigilant de cada minut de l'escriptori
    (`spawn_reminder_watch`) la crida amb els comptes que té oberts i
    emet el que retorna, com abans; el mòbil la crida des de
    `pim.refresh` amb els comptes desats. El registre de «ja donat» és el
    mateix, de manera que un recordatori es dona una vegada, sigui qui sigui
    qui pregunti.
  - **Refrescament periòdic.** `pim.refresh` lliura els recordatoris i, si
    se li permet (`sync`), llegeix la finestra fixa d'ahir a cinc setmanes
    vista de cada compte amb calendaris remots la darrera lectura bona dels
    quals tingui més de 15 minuts (`pim::calendar::sync_now`, el mateix
    refrescament que `spawn_sync`, esperat), i cada llibreta Google o CardDAV
    amb més d'una hora; crea la llibreta de cada compte Google. El que ha
    vençut es llegeix del magatzem (`synced_at`, `last_sync_at`), de manera
    que el procés d'una tasca de fons decideix igual que el de primer pla;
    una fallada no es reintenta abans del seu interval en el mateix procés.
    `only` limita la lectura a calendaris o llibretes i `force` llegeix
    encara que no hagi vençut. L'escriptori no tenia temporitzador per a
    això (refresca en obrir una visualització o en prémer sincronitzar) i
    continua sense.
  - **On s'executa.** En primer pla, la interfície el crida cada minut
    (només recordatoris, sense xarxa) i cada 15 minuts amb lectura, i publica
    els recordatoris per `MobileHost.notifyCalendarReminder` (canal propi
    a Android, `UNUserNotificationCenter` a iOS). En segon pla va
    darrere del correu al `WorkManager` d'Android i al
    `BGAppRefreshTask` d'iOS, que publiquen els recordatoris de la
    resposta. La lectura segueix les regles del correu: tasca de fons només
    amb la sincronització de fons activada i amb xarxa; a iOS, sense xarxa si
    l'interval de comprovació és «Desactivat».
  - **Errors visibles.** `calendar.syncError` i les fallades de llibretes es
    mostren com a avís no bloquejant a Calendari i Contactes. El de
    permís de Google absent té la seva pròpia frase, perquè al mòbil
    reconnectar no ho arregla.

## Alternatives descartades

- **Deixar els gestors a `main.rs` i duplicar-los a `protocol/`:** dues
  còpies de regles delicades (versions de contactes, conflictes CalDAV,
  calendaris locals i subscrits, protecció de Graph) que acabarien
  divergint; cada correcció s'hauria de fer dues vegades.
- **Un magatzem propi del mòbil per a calendari i contactes:** una altra
  arquitectura de plataforma, que la decisió del propietari exclou, i
  una segona veritat per sincronitzar amb la del nucli.
- **Passar el `Writer` de stdout al codi compartit:** lliga la biblioteca
  al procés de l'escriptori; el mòbil no té stdout per llegir.
- **Programar ja la sincronització periòdica al mòbil:** depèn de les
  tasques de fons de cada plataforma (WorkManager, `BGAppRefreshTask`) i
  mereix la seva pròpia decisió.

## Proves

- Nucli, per l'entrada mòbil (`invoke_mobile_protocol_json` amb un
  directori de dades temporal):
  - `mobile_calendar_commands_run_the_shared_core`: llista i amaga un
    calendari local; crea, llegeix (comparat amb el que desa la memòria cau,
    que és el que respon l'escriptori), detalla, edita (la clau de canvi
    puja) i suprimeix un esdeveniment amb els paràmetres exactes de Kotlin;
    rebutja una sèrie en un calendari local i una finestra al revés amb els
    mateixos missatges que l'escriptori.
  - `mobile_people_commands_run_the_shared_core`: crea, llista, edita,
    detecta una edició desfasada, rebutja una edició sense versió i suprimeix
    a la llibreta local.
  - `calendar_refresh_reports_over_the_event_channel` (`ffi.rs`): el
    refrescament que llança `calendar.events` continua després de respondre
    i arriba com a `calendar.synced` al canal d'esdeveniments.
- `mobile_pim_refresh_raises_reminders_and_routes_book_sync`: per l'entrada
  mòbil, `pim.refresh` dona un recordatori una vegada amb la forma de
  l'escriptori, deixa en pau un compte sense res remot, respecta `only` i
  `force`, i `google.contacts.sync`, `carddav.sync` i `carddav.list`
  responen amb el codi compartit.
- `pim::reminders` (vençut una vegada, esdeveniment mogut, calendari ocult,
  neteja) i `pim::refresh` (finestra fixa, interval de reintent).
- `the_reminder_watch_uses_the_shared_reminders` (binari): el vigilant
  de l'escriptori pregunta a `pim::reminders` pels comptes oberts, i el que
  s'ha donat queda registrat on mira el mòbil.
- Kotlin: `PimRefreshTest` (resposta, paràmetres, regles de xarxa i de tic,
  avisos) i `PimSyncModelTest` (errors per compte o llibreta, avís).
- Escriptori: les proves del distribuïdor (`cargo test --bin meron-core`)
  sense canvis, incloses les de reintent de fons, calendari local i
  llibreta local.
- `cargo test --lib`, i `calendar::` amb `TZ=Asia/Tokyo` i
  `TZ=America/Los_Angeles`.

## Pendent

- L'OAuth de Google del mòbil no demana `auth/calendar` ni
  `contacts.readonly`: fins que el propietari els afegeixi (pantalla de
  consentiment, client OAuth del navegador i `GoogleAccountManagerAuth`)
  i es reconnecti el compte, el calendari i la llibreta d'un compte
  Google fallen al mòbil, amb un avís que ho diu. Aquesta ampliació no
  toca els permisos.
- Recordatoris programats per endavant: avui es donen quan arriba la seva hora
  (tic de primer pla o tasca de fons); amb l'aplicació suspesa a iOS
  poden arribar tard o perdre's.
- Exchange no té llibreta per sincronitzar (tampoc a l'escriptori: només la
  cerca al directori), i el mòbil no té bústia Exchange pròpia.
- L'alta de CalDAV, subscripcions i CardDAV no s'atén al mòbil
  (`calendar.createLocal` sí, perquè un telèfon nou tingui on posar
  un esdeveniment); les contrasenyes de CalDAV i CardDAV són al
  clauer de l'escriptori.
- Evidència al dispositiu (Maestro).

Fet des de la primera versió d'aquesta ADR (ampliació del 2026-10-13):
sincronització periòdica del calendari al mòbil, recordatoris
(`calendar.reminder`) al mòbil com a notificacions locals,
sincronització de llibretes (Google, CardDAV) al mòbil i
`calendar.syncError` a la interfície mòbil.
