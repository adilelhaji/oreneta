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
  y avisa con `calendar.synced` o `calendar.syncError`. No hay
  sincronización periódica ni recordatorios en el móvil.

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
- Escritorio: las pruebas del despachador (`cargo test --bin meron-core`)
  sin cambios, incluidas las de reintento de fondo, calendario local y
  libreta local.
- `cargo test --lib`, y `calendar::` con `TZ=Asia/Tokyo` y
  `TZ=America/Los_Angeles`.

## Pendiente

- Sincronización periódica del calendario en el móvil, y recordatorios
  (`calendar.reminder`), que hoy solo emite el escritorio.
- Sincronizar libretas (Google, Exchange, CardDAV) en el móvil.
- El OAuth de Google del móvil no pide `auth/calendar` (ni
  `contacts.readonly`): hasta ampliarlo y reconectar, el calendario de una
  cuenta Google responde con error en el móvil.
- `calendar.createLocal` y el alta de CalDAV, suscripciones y CardDAV no se
  atienden en el móvil; las contraseñas de CalDAV y CardDAV están en el
  llavero del escritorio.
- La interfaz móvil no muestra `calendar.syncError`.
- Evidencia en dispositivo (Maestro).
