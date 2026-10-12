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
| Calendario | No | Pendiente |
| Contactos | Solo sugerencias al escribir; sin libreta | Pendiente |
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
