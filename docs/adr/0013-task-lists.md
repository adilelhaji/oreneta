# ADR-0013: Listas de tareas locales

- Estado: aceptada.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #103.
- Aprobación humana: «Listas locales y migración», elegida entre las opciones
  de [la propuesta](../design/full-tasks-decisions.md).

## Decisión

- Listas y tareas sueltas guardadas en el equipo, con título, nota, fecha
  límite, recordatorio, prioridad (baja, normal o alta), estado y enlace
  opcional a una conversación.
- Las tareas enlazadas actuales pasan a una lista local «Seguimiento de
  correo» sin perder ningún campo. La regla de una tarea abierta por
  conversación se mantiene.
- Sin sincronización, repetición ni delegación en esta entrega. El siguiente
  paso es CalDAV (VTODO), con la política de conflictos de ADR-0012 y una
  decisión sobre la cola sin conexión que se toma junto con la del calendario.

## Consecuencias

La migración se prueba en ida y vuelta (N1) y no cambia el comportamiento de
las tareas enlazadas validado en #42.
