# ADR-0039: Listas de tareas en un servidor CalDAV

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-12.
- Alcance: #103, paso «CalDAV VTODO primero», sobre ADR-0013, ADR-0012 y
  ADR-0018.

## Problema

Las listas de ADR-0013 solo viven en este equipo. El siguiente paso
acordado es sincronizarlas con CalDAV (VTODO), que se puede probar contra
Radicale. Faltaba decidir:

- cómo se enlaza una lista;
- qué pasa con los cambios hechos sin conexión;
- cómo se resuelve un conflicto;
- qué se conserva de lo que escribieron otros programas.

## Decisión

- **Enlace:** una lista se enlaza con una sola colección del servidor. Se
  añade con «Lista de tareas CalDAV…»: servidor y usuario, después la
  colección y después el nombre aquí.
  - La contraseña va al llavero, con el nombre `caldav-tasks:{lista}`, y
    se añade a lo que purga ADR-0038.
  - La lista se lee entera antes de añadirla. Si esa lectura falla, no se
    añade nada y el diálogo dice por qué.
  - Se ofrecen todas las colecciones de calendario. No se pregunta cuáles
    aceptan tareas: si una no las acepta, lo dice la primera lectura.
- **Cambios locales primero:** crear, editar, completar y borrar se
  guardan aquí y se marcan como pendientes (`put` o `delete`).
  - Una tarea borrada que ya está en el servidor queda oculta (lápida)
    hasta que se borra allí, porque hace falta su versión para borrarla.
  - No se envía nada en segundo plano. Se sincroniza al abrir Tareas y con
    el botón «Sincronizar».
- **Sincronizar una lista:**
  1. **Enviar:** los cambios pendientes salen de uno en uno, cada uno con
     su versión.
     - Una tarea nueva va con `If-None-Match: *`. Su dirección se decide y
       se guarda antes de enviarla, para que un reintento no cree otra
       copia.
     - Una edición va con `If-Match` y un borrado con `DELETE` e `If-Match`.
     - Un 412 marca esa tarea en conflicto y detiene la cola de esa lista;
       las demás listas siguen. Mientras la lista tenga un conflicto, no
       envía nada más.
     - Un error de red o del servidor detiene la sincronización y se guarda
       como «último error». No se pierde nada local.
  2. **Leer:** se piden todas las tareas de la colección (`REPORT` con
     `VTODO`, sin ventana de tiempo). Es todo o nada: si un objeto no
     vuelve, está en otro servidor o no se puede leer, la lectura falla y
     lo local no cambia.
  3. **Conciliar** por dirección del objeto:

     | Servidor | Aquí | Resultado |
     |---|---|---|
     | Cambió | Sin cambios | Se toma la copia del servidor |
     | Cambió | Con cambios | Conflicto; no se sobrescribe ninguna |
     | Desapareció | Sin cambios | Se borra aquí |
     | Desapareció | Con cambios | Conflicto («borrada en el servidor») |
     | Nueva | — | Se añade aquí |
- **Conflictos (ADR-0012), sin fusión silenciosa.** La tarea muestra
  «Conflicto» con dos acciones:
  - «Conservar la mía»: lee la versión actual del servidor y vuelve a
    poner la tarea en cola sobre esa versión, o la crea de nuevo en la
    misma dirección si se borró allí. Después sincroniza.
  - «Usar la del servidor»: toma la copia del servidor, o borra la tarea
    aquí si allí ya no existe.
- **Lo que se conserva:** al escribir sobre un objeto existente solo se
  cambian las propiedades cuyo valor cambió aquí. Todo lo demás se queda
  igual: X-, `CATEGORIES`, `RELATED-TO`, `VTIMEZONE`, otras alarmas.
  `DTSTAMP` y `LAST-MODIFIED` se actualizan y `SEQUENCE` sube. Las tareas
  nuevas llevan UID `<uuid>@oreneta`.
- **Correspondencia de campos:**
  - `SUMMARY` ↔ título y `DESCRIPTION` ↔ nota, con escapes.
  - `DUE` ↔ fecha límite:
    - una fecha sola es la medianoche local;
    - una hora con `TZID` se lee en su zona, y una sin zona, como hora
      local;
    - al escribir, una medianoche local va como `VALUE=DATE` y cualquier
      otra hora, en UTC.
  - `PRIORITY` ↔ prioridad: 1–4 es alta, 6–9 baja y 5, 0 o ninguna,
    normal. Al escribir, alta es 1, baja es 9 y normal quita la propiedad.
  - `STATUS:COMPLETED` y `COMPLETED` ↔ completada. Reabrir escribe
    `NEEDS-ACTION` y quita `COMPLETED` y `PERCENT-COMPLETE`.
  - La primera alarma con hora calculable ↔ recordatorio. Si el
    recordatorio cambia aquí, las alarmas se sustituyen por una sola
    `DISPLAY` con hora absoluta. Si no cambia, no se tocan.
- **Tareas que se repiten** (`RRULE`, `RDATE` u ocurrencias cambiadas): se
  muestran, pero no se editan ni se completan aquí; el mensaje lo dice.
  Sí se pueden borrar.
- **Mover una tarea** entre una lista del servidor y otra lista se rechaza
  por ahora, con un mensaje.
- **Borrar una lista enlazada** borra aquí la lista, sus tareas y su
  contraseña. No toca nada del servidor, y el texto de confirmación lo dice.
- **Seguridad (#28):** la contraseña solo va al origen de la colección.
  Se comprueba al enlazar (con las reglas de `credentials_may_follow`
  desde lo que se escribió) y en cada petición. Un objeto que el servidor
  sitúa en otro origen hace fallar la lectura.
- **Esquema 56:**
  - `task_lists`: `remote_url`, `remote_user`, `synced_at` y `last_error`;
  - `tasks`: `remote_href`, `remote_etag`, `remote_ics`, `pending`,
    `conflict`, `recurring` y `sync_seq`.

  Ninguna columna se llama `account`, así que no entran en el borrado por
  cuenta.

## Alternativas descartadas

- **Sincronizar en segundo plano con un temporizador:** sería la primera
  tarea periódica de red de las tareas. Puede venir después. Abrir la vista
  y el botón bastan para esta entrega.
- **Que gane el último en escribir:** contradice ADR-0012.
- **Mover entre listas** como borrar en una y crear en otra: puede perder
  datos si falla a mitad. Se deja para cuando haga falta.
- **Leer `supported-calendar-component-set`** para filtrar colecciones:
  pide otra consulta por colección y el analizador actual no lee atributos.
  La primera lectura ya informa de una colección que no sirve.

## Consecuencias

- Pruebas N1 con un servidor falso y N3 contra Radicale; el detalle está en
  el [registro](../design/caldav-tasks.md).
- Google Tasks, Graph To Do y EWS siguen pendientes, en ese orden
  (ADR-0013).
