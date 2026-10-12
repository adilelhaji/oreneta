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
| Calendario | Interfaz lista: calendarios (mostrar u ocultar), agenda por días de dos semanas, detalle del evento y crear, editar y borrar en calendarios con escritura. Sin avisar a invitados ni editar series. El núcleo móvil atiende `calendar.*` con el código del escritorio (ADR-0045); refresco al pedir, sin sincronización periódica | Sincronización periódica; evidencia en dispositivo |
| Contactos | Interfaz lista: libreta con búsqueda, ficha, escribir a una dirección, y crear, editar y borrar en la libreta local y en CardDAV con escritura. El núcleo móvil atiende `people.*` con el código del escritorio (ADR-0045); sin sincronizar libretas | Sincronizar libretas en móvil; evidencia en dispositivo |
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
  que cae. No hay sincronización periódica: con la app cerrada o sin abrir
  la agenda, nada se refresca, y los recordatorios (`calendar.reminder`)
  no se emiten en el móvil. Las libretas (Google, Exchange, CardDAV) no se
  sincronizan en el móvil: `people.list` lee lo que haya en el almacén del
  dispositivo. Desde el móvil no se pueden añadir calendarios CalDAV,
  suscripciones ni libretas CardDAV, y sus contraseñas viven en el llavero
  del escritorio. Además, el OAuth de Google en el móvil solo pide correo y
  perfil (sin `auth/calendar`), así que el calendario de una cuenta Google
  responde con error del servidor hasta que se amplíe ese permiso y se
  vuelva a conectar la cuenta; y el móvil no tiene buzón Exchange propio.
  Como `calendar.createLocal` tampoco se atiende en el móvil, hoy, en la
  práctica, solo funcionan la libreta local y los calendarios locales que
  ya estén en el almacén del dispositivo.
- **Pruebas.** Comunes de Kotlin: `CalendarCommandsTest` y
  `PeopleCommandsTest` (lectura de respuestas y forma exacta de cada
  petición, comparada con lo que envía el escritorio), `CalendarAgendaTest`
  (ventana por días locales, agrupación, días completos, reglas de escritura
  y de invitados, peticiones de guardar y borrar), `ContactsModelTest` y
  `PimRoutesTest`. En el núcleo: `mobile_calendar_commands_run_the_shared_core`
  y `mobile_people_commands_run_the_shared_core` (por la entrada móvil, con
  los parámetros de Kotlin) y `calendar_refresh_reports_over_the_event_channel`.
  Falta la evidencia en dispositivo (Maestro).
