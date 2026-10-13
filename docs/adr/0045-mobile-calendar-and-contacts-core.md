# ADR-0045: Calendario y contactos del móvil en el núcleo compartido

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-12.
- Alcance: los diez comandos que usa la interfaz móvil de calendario y
  contactos (`calendar.list`, `calendar.setEnabled`, `calendar.events`,
  `calendar.eventDetails`, `calendar.create`, `calendar.update`,
  `calendar.delete`, `people.list`, `people.save`, `people.delete`), tras
  la decisión del propietario del 2026-10-12 de llevar calendario y
  contactos al móvil reutilizando el núcleo del escritorio
  (`docs/design/mobile-inventory.md`). Ningún otro comando (invitaciones,
  tareas, notas…) cambia.

## Decisión

- **Un solo código para los dos.** La lógica de esos comandos sale del
  `dispatch` del binario de escritorio (`meron-core/src/main.rs`) a la
  biblioteca, en `meron-core/src/pim/`:
  - `pim::calendar`: `list`, `set_enabled`, `events`, `event_details`,
    `create`, `update`, `delete`, y lo que necesitan (`local_calendar_write`,
    `caldav_target`, `caldav_write`, `CALDAV_CONFLICT`, `spawn_sync` y la
    sincronización de una ventana);
  - `pim::people`: `list`, `save`, `delete`, y la escritura CardDAV y en la
    libreta local (`carddav_create` y compañía, `PersonInput`);
  - cada función recibe el `Engine` y los parámetros de la petición y
    devuelve el JSON que el anfitrión reenvía sin tocarlo.
- **El escritorio no cambia.** Los brazos de `dispatch` pasan a ser una
  llamada a esas funciones. Respuestas, errores y eventos son los mismos
  byte a byte; las pruebas del despachador siguen igual.
- **Eventos de fondo con una abstracción mínima.** Lo que termina después
  de responder (el refresco de una ventana) avisa por `pim::Emit`, una
  función `(nombre, detalle)` asíncrona:
  - en escritorio escribe `{"event", "detail"}` en stdout, como el resto de
    eventos (`emitter` en `main.rs`);
  - en móvil llama a `ffi::emit_event`, el canal de eventos de la
    plataforma.
- **El reintento de fondo pasa a la biblioteca.** `is_transient_sync_error`,
  `BackgroundSyncCancelled` y el reintento único
  (`engine::retry_background_sync_after`) se mueven a `engine.rs`; el
  binario conserva `retry_background_sync` como envoltorio con su propio
  retraso, así que sus otras sincronizaciones no cambian.
- **Ruta móvil.** `protocol::dispatch_mobile_protocol_request` envía esos
  diez métodos a `protocol/pim.rs`, que toma el `Engine` con
  `ffi::engine_for` (el de primer plano, o uno transitorio), aplica la
  misma guarda de Graph que el escritorio y ejecuta la función compartida
  con `ffi::engine_block_on`. Los parámetros son los del escritorio
  (`account`, `calendar`, `event`, `change_key`, `series`, `scope`,
  `notify`, `query`, `limit`, `id`, `version`, `book`, `person`); el
  código Kotlin ya los enviaba así y no cambia.
- **Sincronización en el móvil: refresco al pedir.** `calendar.events` con
  `refresh` (y una escritura en un calendario de cuenta) lanza el refresco
  de la ventana en el runtime del `Engine`, que sigue después de responder
  y avisa con `calendar.synced` o `calendar.syncError`.
- **Ampliación del 2026-10-13: refresco periódico, libretas y
  recordatorios.** Un comando móvil más, `pim.refresh`
  (`meron-core/src/pim/refresh.rs`), y tres que ya tenía el escritorio
  (`google.contacts.sync`, `carddav.sync`, `carddav.list`), con su lógica
  movida de `main.rs` a `pim::people` (`sync_source`, `google_sync`,
  `source_sync`, `sources`); los brazos del escritorio las llaman y
  responden igual.
  - **Recordatorios compartidos.** `pim::reminders::take_due` decide qué
    recordatorios han vencido (`calendar::due_reminders`) y los marca como
    dados antes de devolverlos, con la forma del evento
    `calendar.reminder`. El vigilante de minuto del escritorio
    (`spawn_reminder_watch`) la llama con las cuentas que tiene abiertas y
    emite lo que devuelve, como antes; el móvil la llama desde
    `pim.refresh` con las cuentas guardadas. El registro de «ya dado» es el
    mismo, así que un recordatorio se da una vez sea quien sea quien
    pregunte.
  - **Refresco periódico.** `pim.refresh` entrega los recordatorios y, si
    se le deja (`sync`), lee la ventana fija de ayer a cinco semanas vista
    de cada cuenta con calendarios remotos cuya última lectura buena tenga
    más de 15 minutos (`pim::calendar::sync_now`, el mismo refresco que
    `spawn_sync`, esperado), y cada libreta Google o CardDAV con más de una
    hora; crea la libreta de cada cuenta Google. Lo vencido se lee del
    almacén (`synced_at`, `last_sync_at`), así que el proceso de una tarea
    de fondo decide igual que el de primer plano; un fallo no se reintenta
    antes de su intervalo en el mismo proceso. `only` limita la lectura a
    calendarios o libretas y `force` lee aunque no haya vencido. El
    escritorio no tenía temporizador para esto (refresca al abrir una vista
    o al pulsar sincronizar) y sigue sin él.
  - **Dónde corre.** En primer plano, la interfaz lo llama cada minuto
    (solo recordatorios, sin red) y cada 15 minutos con lectura, y publica
    los recordatorios por `MobileHost.notifyCalendarReminder` (canal propio
    en Android, `UNUserNotificationCenter` en iOS). En segundo plano va
    detrás del correo en el `WorkManager` de Android y en el
    `BGAppRefreshTask` de iOS, que publican los recordatorios de la
    respuesta. La lectura sigue las reglas del correo: tarea de fondo solo
    con la sincronización de fondo activada y con red; en iOS, sin red si
    el intervalo de comprobación es «Desactivado».
  - **Errores visibles.** `calendar.syncError` y los fallos de libretas se
    muestran como aviso no bloqueante en Calendario y Contactos. El de
    permiso de Google ausente tiene su propia frase, porque en el móvil
    reconectar no lo arregla.

## Alternativas descartadas

- **Dejar los manejadores en `main.rs` y duplicarlos en `protocol/`:** dos
  copias de reglas delicadas (versiones de contactos, conflictos CalDAV,
  calendarios locales y suscritos, guarda de Graph) que acabarían
  divergiendo; cada arreglo habría que hacerlo dos veces.
- **Un almacén propio del móvil para calendario y contactos:** otra
  arquitectura de plataforma, que la decisión del propietario excluye, y
  una segunda verdad que sincronizar con la del núcleo.
- **Pasar el `Writer` de stdout al código compartido:** ata la biblioteca
  al proceso del escritorio; el móvil no tiene stdout que leer.
- **Programar ya la sincronización periódica en el móvil:** depende de las
  tareas de fondo de cada plataforma (WorkManager, `BGAppRefreshTask`) y
  merece su propia decisión.

## Pruebas

- Núcleo, por la entrada móvil (`invoke_mobile_protocol_json` con un
  directorio de datos temporal):
  - `mobile_calendar_commands_run_the_shared_core`: lista y oculta un
    calendario local; crea, lee (comparado con lo que guarda la caché, que
    es lo que responde el escritorio), detalla, edita (la clave de cambio
    sube) y borra un evento con los parámetros exactos de Kotlin; rechaza
    una serie en un calendario local y una ventana al revés con los mismos
    mensajes que el escritorio.
  - `mobile_people_commands_run_the_shared_core`: crea, lista, edita,
    detecta una edición desfasada, rechaza una edición sin versión y borra
    en la libreta local.
  - `calendar_refresh_reports_over_the_event_channel` (`ffi.rs`): el
    refresco que lanza `calendar.events` sigue tras responder y llega como
    `calendar.synced` al canal de eventos.
- `mobile_pim_refresh_raises_reminders_and_routes_book_sync`: por la
  entrada móvil, `pim.refresh` da un recordatorio una vez con la forma del
  escritorio, deja en paz una cuenta sin nada remoto, respeta `only` y
  `force`, y `google.contacts.sync`, `carddav.sync` y `carddav.list`
  responden con el código compartido.
- `pim::reminders` (vencido una vez, evento movido, calendario oculto,
  limpieza) y `pim::refresh` (ventana fija, intervalo de reintento).
- `the_reminder_watch_uses_the_shared_reminders` (binario): el vigilante
  del escritorio pregunta a `pim::reminders` por las cuentas abiertas, y lo
  dado queda registrado donde mira el móvil.
- Kotlin: `PimRefreshTest` (respuesta, parámetros, reglas de red y de tic,
  avisos) y `PimSyncModelTest` (errores por cuenta o libreta, aviso).
- Escritorio: las pruebas del despachador (`cargo test --bin meron-core`)
  sin cambios, incluidas las de reintento de fondo, calendario local y
  libreta local.
- `cargo test --lib`, y `calendar::` con `TZ=Asia/Tokyo` y
  `TZ=America/Los_Angeles`.

## Pendiente

- El OAuth de Google del móvil no pide `auth/calendar` ni
  `contacts.readonly`: hasta que el propietario los añada (pantalla de
  consentimiento, cliente OAuth del navegador y `GoogleAccountManagerAuth`)
  y se reconecte la cuenta, el calendario y la libreta de una cuenta
  Google fallan en el móvil, con un aviso que lo dice. Esta ampliación no
  toca los permisos.
- Recordatorios programados por adelantado: hoy se dan al llegar su hora
  (tic de primer plano o tarea de fondo); con la app suspendida en iOS
  pueden llegar tarde o perderse.
- Exchange no tiene libreta que sincronizar (tampoco en escritorio: solo la
  búsqueda en el directorio), y el móvil no tiene buzón Exchange propio.
- El alta de CalDAV, suscripciones y CardDAV no se atiende en el móvil
  (`calendar.createLocal` sí, para que un teléfono nuevo tenga dónde poner
  un evento); las contraseñas de CalDAV y CardDAV están en el
  llavero del escritorio.
- Evidencia en dispositivo (Maestro).

Hecho desde la primera versión de esta ADR (ampliación del 2026-10-13):
sincronización periódica del calendario en el móvil, recordatorios
(`calendar.reminder`) en el móvil como notificaciones locales,
sincronización de libretas (Google, CardDAV) en el móvil y
`calendar.syncError` en la interfaz móvil.
