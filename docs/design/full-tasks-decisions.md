# Tareas completas: decisión pendiente (#103)

Estado: **propuesta**. #103 pide presentar esta decisión y aprobarla en un ADR
antes de escribir código. El contrato actual (tareas locales enlazadas a una
conversación, una abierta por conversación) no cambia sin esa aprobación.
Su validación está en [message-linked-tasks.md](message-linked-tasks.md).

## Qué ofrecen los proveedores

| Capacidad | Google Tasks | CalDAV (VTODO) | Exchange (EWS) | Graph (To Do) |
|---|---|---|---|---|
| Listas | Sí | Una por colección | Carpetas de tareas | Sí |
| Tarea suelta | Sí | Sí | Sí | Sí |
| Fecha límite | Solo fecha | Fecha y hora | Fecha y hora | Fecha y hora |
| Recordatorio | No | `VALARM` | Sí | Sí |
| Prioridad | No | 1–9 | Baja/normal/alta | Baja/normal/alta |
| Repetición | No por API | `RRULE` | Patrones EWS | Patrones Graph |
| Subtareas | Un nivel | `RELATED-TO` | No | Pasos (checklist) |
| Delegación | No | No estándar | Sí (asignar) | No |
| Versión para conflictos | `etag` | ETag | `ChangeKey` | `@odata.etag` |

Las diferencias son grandes. Un modelo común tiene que decir qué campo se
pierde en cada proveedor, en vez de prometer lo que el proveedor no guarda.

## Decisiones

1. **Modelo.** Propuesta: una tabla de tareas con lista, título, nota, fecha
   límite (fecha u hora), recordatorio, prioridad (baja/normal/alta), estado y
   enlace opcional a una conversación. Las tareas enlazadas actuales migran a
   una lista local «Seguimiento de correo» sin perder nada. La regla de una
   tarea abierta por conversación se mantiene para las enlazadas.
2. **Primera entrega solo local.** Listas y tareas sueltas, sin repetición ni
   delegación. Incluye búsqueda y aparición en la agenda.
3. **Sincronización, por proveedor y en este orden:**
   1. CalDAV VTODO, que se puede probar contra Radicale en CI;
   2. Google Tasks, con un permiso nuevo (`tasks`) que depende de los
      registros OAuth de #144;
   3. Graph To Do, con `Tasks.ReadWrite`;
   4. EWS, con evidencia de un servidor real.

   Cada campo que un proveedor no guarda se indica en la interfaz al elegir la
   lista.
4. **Conflictos.** Propuesta: los mismos que en el calendario y los contactos.
   Escribir con la versión leída; si el servidor responde 412, no se guarda
   nada y se pregunta. Sin fusión silenciosa.
5. **Sin conexión.** Propuesta: los cambios se guardan en local y se marcan
   como pendientes. Se envían al reconectar, de uno en uno y con versión, y un
   conflicto detiene la cola de esa lista, no las demás. Esto necesita la
   misma decisión que la cola sin conexión del calendario (#101), y conviene
   tomarlas juntas.
6. **Repetición y delegación.** Propuesta: fuera de las primeras entregas.
   Repetición solo cuando haya un proveedor que la sincronice; delegación
   solo en Exchange.

## Pruebas exigidas por #103

- N1: alta, edición, completar y reabrir.
- N1: migración desde las tareas enlazadas, en ida y vuelta, sin pérdida.
- N1: aislamiento entre cuentas.
- N3: conflicto e interrupción contra Radicale.
- N2: flujos de la vista.
- N5: con cada proveedor real antes de anunciarlo.
