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
| Calendario | Interfaz lista: calendarios (mostrar u ocultar), agenda por días de dos semanas, detalle del evento y crear, editar y borrar en calendarios con escritura. Sin avisar a invitados ni editar series. El núcleo móvil aún no atiende `calendar.*` | Conectar `calendar.*` al núcleo móvil; evidencia en dispositivo |
| Contactos | Interfaz lista: libreta con búsqueda, ficha, escribir a una dirección, y crear, editar y borrar en la libreta local y en CardDAV con escritura. El núcleo móvil aún no atiende `people.*` | Conectar `people.*` al núcleo móvil; evidencia en dispositivo |
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
- **Bloqueo en el núcleo.** El puente móvil (`meron-core/src/ffi.rs`) solo
  despacha `protocol::dispatch_mobile_protocol_request`, que no conoce
  `calendar.*` ni `people.*`: esos comandos viven en el `dispatch` del
  binario de escritorio (`main.rs`). Hasta que se conecten, el móvil
  responde con un aviso de que esta versión aún no abre calendarios ni
  contactos, sin datos inventados. Tampoco hay sincronización de calendarios
  ni de CardDAV en el móvil.
- **Pruebas.** Comunes de Kotlin: `CalendarCommandsTest` y
  `PeopleCommandsTest` (lectura de respuestas y forma exacta de cada
  petición, comparada con lo que envía el escritorio), `CalendarAgendaTest`
  (ventana por días locales, agrupación, días completos, reglas de escritura
  y de invitados, peticiones de guardar y borrar), `ContactsModelTest` y
  `PimRoutesTest`. Falta la evidencia en dispositivo (Maestro) una vez el
  núcleo móvil atienda estos comandos.
