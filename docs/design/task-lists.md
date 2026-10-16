# Listas de tareas locales (#103, ADR-0013)

## Qué hace

- **Tareas** muestra pestañas por lista: «Todas», «Seguimiento de correo» y
  las listas creadas. Se puede crear, renombrar y borrar una lista; al borrar
  una lista se borran sus tareas, tras confirmarlo. «Seguimiento de correo»
  no se puede borrar.
- «Nueva tarea» crea una tarea suelta en la lista que se está viendo. Lleva
  título (obligatorio), lista, fecha límite, recordatorio (fecha y hora),
  prioridad (baja, normal o alta) y nota.
- Una búsqueda filtra por título, asunto, nota y remitente.
- Abrir una tarea suelta la edita; abrir una enlazada sigue llevando a su
  conversación.
- La prioridad alta se marca con una bandera, y el recordatorio pendiente se
  ve en la fila.
- **Recordatorios.** Llegan como notificación del sistema
  (`tasks.reminder`), una sola vez. Vuelven a sonar solo si se cambia la hora,
  y una tarea terminada no suena.
- **Conflictos.** Editar exige la revisión leída. Si otra ventana cambió la
  tarea, no se guarda nada y se muestran las dos copias, con la misma
  política que los contactos (ADR-0012).

## Modelo

- **Migración 39.**
  - Crea la tabla `task_lists` con la lista fija `mail`.
  - Añade a `tasks` las columnas `list_id`, `title`, `priority`,
    `reminder_at`, `reminded_at` y `revision`.
  - Las tareas que ya existían pasan a `mail` sin perder campos (probado con
    una actualización simulada).
- **Una tarea abierta por conversación.** Se mantiene: el índice único parcial
  se aplica ahora solo a las tareas con conversación (`thread_key <> ''`).
  Las sueltas no tienen conversación y no cuentan para esa regla.
- **Órdenes del puente:**
  - nuevas: `tasks.lists`, `tasks.createList`, `tasks.renameList`,
    `tasks.deleteList`, `tasks.create` y `tasks.update`;
  - ampliadas: `tasks.list` y `tasks.get` devuelven los campos nuevos.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 almacén (`store/task_lists/tests.rs`) | Las enlazadas van a `mail` y conservan la regla; las sueltas no la tienen; listas (crear, renombrar, borrar con sus tareas, `mail` protegida, una lista borrada no admite tareas); conflicto de revisión; el recordatorio suena una vez y otra solo al moverlo, no si la tarea está terminada; la actualización conserva las tareas |
| N1 despachador (`main.rs`) | Recorrido completo por el puente |
| N2 vista (`TaskLists.test.tsx`) | Pestañas y búsqueda; abrir una suelta la edita; alta en la lista que se ve, con título obligatorio; conflicto y «Conservar la mía» |
| N6 accesibilidad | Auditoría axe de Tareas y de su editor, en tema claro y oscuro |

## Fuera de esta entrega (ADR-0013)

Repetición, delegación, subtareas y aparición en la agenda del calendario.
La sincronización con CalDAV (VTODO) llegó después, en ADR-0039
([registro](caldav-tasks.md)), y la carpeta Tareas de una cuenta de Exchange
(EWS) en ADR-0058; Google Tasks y Graph To Do siguen
pendientes.
