# Inventario móvil (#116)

Oreneta móvil (`mobile/`) es una aplicación Kotlin Multiplatform para
Android e iOS. Usa el mismo núcleo `meron-core` por su protocolo de
comandos. Este inventario sale de los comandos que la parte compartida
(`mobile/shared/src/commonMain`) envía al núcleo. Se compara con eM Client
para iOS y Android por separado: el escritorio no demuestra nada sobre el
móvil.

| Área | Móvil hoy | Seguimiento |
|---|---|---|
| Correo IMAP/SMTP, Google y Outlook con OAuth | Sí: sincronizar, leer, enviar, borradores, mover, archivar, carpetas, adjuntos | Paridad por comprobar en dispositivo |
| Exchange (EWS/Graph) | Solo el canje OAuth de Outlook; sin buzón Exchange propio | Pendiente |
| POP3 | No | Pendiente |
| Calendario | Interfaz lista: calendarios (mostrar u ocultar), agenda por días de dos semanas, detalle del evento y crear, editar y borrar en calendarios con escritura. Sin avisar a invitados ni editar series. El núcleo móvil atiende `calendar.*` con el código del escritorio (ADR-0045); refresco al pedir y periódico (`pim.refresh`), recordatorios como notificaciones locales y errores de sincronización en un aviso | Recordatorios programados por adelantado en iOS; evidencia en dispositivo |
| Contactos | Interfaz lista: libreta con búsqueda, ficha, escribir a una dirección, y crear, editar y borrar en la libreta local y en CardDAV con escritura. El núcleo móvil atiende `people.*` con el código del escritorio (ADR-0045); libretas Google y CardDAV leídas cada hora y al refrescar (`pim.refresh`), con aviso si fallan | Permiso de contactos en el OAuth de Google del móvil; evidencia en dispositivo |
| Tareas y notas | No | Pendiente |
| OpenPGP y S/MIME | No | Pendiente |
| Búsqueda | Parcial: listas de conversaciones, sin constructor ni búsquedas guardadas | Pendiente |
| RSS | Sí: fuentes, OPML, leído y destacado | — |
| Copia de seguridad | Exportar e importar | — |
| Chat | No | Pendiente |

## Propuesta por delegación

- La paridad declarada es la de escritorio para Windows. El móvil se mide
  aparte y no entra en una declaración de paridad universal: hasta que no
  tenga su propia evidencia, la paridad es **parcial**.
- Cualquier dominio móvil nuevo (calendario, contactos, cifrado) reutiliza
  los comandos del núcleo que ya existen en escritorio. Una arquitectura
  nueva de plataforma necesita su propia aprobación.
- Las pruebas son las que ya existen (pruebas comunes de Kotlin, pruebas de
  Android en host y flujos Maestro). Hace falta evidencia en dispositivo
  por cada dominio que se añada.

Decisión del propietario: qué dominios móviles entran y con qué
presupuesto de pruebas y mantenimiento.

## Calendario y contactos (decisión del 2026-10-12)

Decisión del propietario: en móvil entran primero calendario y contactos,
con los mismos comandos del núcleo que usa el escritorio. Sin arquitectura
nueva de plataforma.

- **Comandos.** Calendario: `calendar.list`, `calendar.setEnabled`,
  `calendar.events`, `calendar.eventDetails`, `calendar.create`,
  `calendar.update` y `calendar.delete`, con los parámetros que
  `calendar.go` pasa al núcleo. Contactos: `people.list`, `people.save` y
  `people.delete`, como `people.go`.
- **Límites a propósito.** El móvil nunca avisa a nadie (`notify` siempre
  falso) y solo cambia la ocurrencia que se tiene delante (`scope`
  `occurrence`). Un evento con otras personas, o de otro organizador, no se
  edita ni se borra desde el móvil: se explica que se haga desde el
  escritorio, que sí puede avisarles. Los calendarios de solo lectura y las
  suscripciones no ofrecen cambios. En contactos, solo la libreta local y
  los libros CardDAV que el servidor deja escribir; Google y el directorio
  son de solo lectura. Un contacto nuevo va a la libreta del dispositivo.
- **En el núcleo (ADR-0045).** Estos diez comandos ya no viven solo en el
  `dispatch` del binario de escritorio (`main.rs`): su código está en la
  biblioteca (`meron-core/src/pim/`), y tanto `dispatch` como el puente
  móvil (`protocol::dispatch_mobile_protocol_request` →
  `protocol/pim.rs`) llaman a las mismas funciones, sobre el mismo
  `Engine`. Las respuestas y los errores son los del escritorio. El aviso
  de «esta versión aún no abre calendarios ni contactos» queda solo para
  núcleos anteriores que respondan `unknown method`.
- **Sincronización en el móvil.** `calendar.events` con `refresh` (lo que
  hace la agenda al abrirse, al cambiar de semana y al volver a «Hoy»)
  refresca esa ventana en segundo plano en el runtime del `Engine`, igual
  que en escritorio, y avisa con `calendar.synced` (o
  `calendar.syncError`) por el canal de eventos; la agenda vuelve a leer la
  caché. Una escritura en un calendario de cuenta refresca la ventana en la
  que cae.
- **Sincronización periódica y recordatorios (`pim.refresh`).** Un comando
  móvil nuevo, sobre `pim::refresh` y `pim::reminders` del núcleo:
  - primero entrega los recordatorios vencidos, con la misma consulta y el
    mismo registro de «ya avisado» que el vigilante del escritorio
    (`spawn_reminder_watch` llama ahora a `pim::reminders::take_due`); la
    forma de cada uno es la del evento `calendar.reminder` del escritorio;
  - si se le deja (`sync`), lee la ventana fija (de ayer a cinco semanas
    vista) de cada cuenta con calendarios remotos cuya última lectura buena
    tenga más de 15 minutos, y cada libreta (Google, CardDAV) con más de
    una hora; un fallo no se reintenta antes de su intervalo en ese
    proceso. Lo vencido se decide con `synced_at` y `last_sync_at` del
    almacén, así que una tarea de fondo en un proceso nuevo decide igual;
  - crea la libreta de cada cuenta Google (`google-<cuenta>`), como hace el
    escritorio cuando se pulsa «Sincronizar contactos de Google».
  En primer plano, `MeronApp` lo llama cada minuto (solo recordatorios) y
  cada 15 minutos con lectura; en iOS la lectura sigue la regla de las
  comprobaciones automáticas del correo (intervalo «Desactivado» = sin
  red). En segundo plano va detrás del correo en el `WorkManager` de
  Android y en el `BGAppRefreshTask` de iOS, que publican ellos mismos los
  recordatorios de la respuesta. Las notificaciones salen por el camino
  existente: un canal propio en Android (`meron_calendar_reminders`) y
  `UNUserNotificationCenter` en iOS, que las muestra también con la app
  abierta. El escritorio no tiene sincronización periódica de calendario
  ni de libretas (refresca al abrir una vista o al pedirlo) y sigue igual.
- **Errores visibles.** `calendar.syncError` y los fallos de libretas de
  `pim.refresh` se muestran como aviso no bloqueante en Calendario y en
  Contactos (por cuenta o libreta; una lectura buena lo borra). El botón de
  refrescar de Contactos lee también las libretas.
- **Pendiente.** Desde el móvil no se pueden añadir calendarios CalDAV,
  suscripciones ni libretas CardDAV, y sus contraseñas viven en el llavero
  del escritorio. Exchange no tiene libreta que sincronizar ni en escritorio
  (solo la búsqueda en el directorio), y el móvil no tiene buzón Exchange
  propio. El OAuth de Google del móvil solo pide correo y perfil (sin
  `auth/calendar` ni `contacts.readonly`): el calendario y la libreta de
  una cuenta Google fallan, y las pantallas lo dicen con un aviso propio
  («el inicio de sesión de Google de la app no pide ese acceso»), porque
  reconectar no sirve. Hace falta que el propietario añada esos permisos a
  la pantalla de consentimiento y al cliente OAuth del móvil (navegador y
  `GoogleAccountManagerAuth`) y que se vuelva a conectar la cuenta; este
  cambio no toca los permisos. Los recordatorios se dan al llegar su hora,
  no se programan por adelantado: con la app suspendida en iOS uno puede
  llegar tarde, o perderse si el sistema no ejecuta la tarea de fondo antes
  de que empiece el evento. En la práctica, hoy funcionan la libreta local
  y los calendarios locales (con sus recordatorios): como un teléfono recién
  instalado no tiene ninguno, la ventana *Calendarios* permite crear uno
  (`calendar.createLocal`, el mismo comando del escritorio), que queda bajo
  la primera cuenta de correo.
- **Pruebas.** Comunes de Kotlin: `CalendarCommandsTest` y
  `PeopleCommandsTest` (lectura de respuestas y forma exacta de cada
  petición, comparada con lo que envía el escritorio), `CalendarAgendaTest`
  (ventana por días locales, agrupación, días completos, reglas de escritura
  y de invitados, peticiones de guardar y borrar), `ContactsModelTest` y
  `PimRoutesTest`. En el núcleo: `mobile_calendar_commands_run_the_shared_core`
  y `mobile_people_commands_run_the_shared_core` (por la entrada móvil, con
  los parámetros de Kotlin), `calendar_refresh_reports_over_the_event_channel`
  y `mobile_pim_refresh_raises_reminders_and_routes_book_sync`; las de
  `pim::reminders` y `pim::refresh`, y en el binario
  `the_reminder_watch_uses_the_shared_reminders`. Kotlin: `PimRefreshTest`
  (compartido) y `PimSyncModelTest` (interfaz).
  Falta la evidencia en dispositivo (Maestro).
