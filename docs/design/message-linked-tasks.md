# Tareas enlazadas a mensajes: validación (#42)

Validación de las tareas locales enlazadas a una conversación contra `main`.
El diseño aprobado no cambia: tareas locales, una tarea abierta por
conversación y sin sincronización remota.

## Estado frente a los criterios de #42

| Criterio | Estado | Evidencia |
|---|---|---|
| La implementación está en `main` | Sí | `store::save_task` y siguientes, `tasks.*` en el núcleo, `TasksView` y `TaskDialog` |
| Sobrevive al reinicio; crear dos veces no duplica | Sí | La tarea está en SQLite con índice único parcial; `saving_a_task_twice_on_the_same_thread_edits_it_rather_than_duplicating_it` |
| Un fallo al leer la nota no la sobrescribe en blanco | **Corregido** | Prueba `when the task cannot be read` en `TaskDialog.test.tsx` |
| El enlace abre la conversación correcta o dice que no la encuentra | **Corregido** | `a_task_follows_its_conversation_to_the_folder_it_moved_to` y la prueba de `TasksView` |
| Aislamiento entre cuentas y conflictos al reabrir | Sí, ampliado | `open_tasks_for_threads_is_scoped_to_the_account_and_excludes_completed`, `reopening_a_task_says_why_it_cannot_and_a_missing_task_is_an_error`, `removing_an_account_removes_its_tasks_and_no_others` |

## Defectos encontrados y corregidos

Cada uno se reprodujo con una prueba que fallaba antes de corregirlo.

- **Tarea duplicada con fechas iguales.** La lista unía la tarea con «el
  mensaje de fecha más reciente». Si dos mensajes del hilo compartían esa
  fecha, la tarea salía dos veces. Ahora un solo mensaje representa la
  conversación, y los empates se deciden por uid.
- **Conversación movida.** Una tarea guardaba la carpeta donde se creó. Si el
  hilo se archivaba o se movía, la tarea salía sin asunto y al abrirla se iba
  a la carpeta vacía. Ahora se busca el hilo primero en su carpeta y después
  en cualquier otra. Al guardarla de nuevo, se registra la carpeta nueva.
- **Hilo que no está en la copia local.** La vista lo dice y no navega. Las
  claves `uid:N` identifican un mensaje de una sola carpeta, así que no se
  buscan en otra: se informa de que no se encuentra en vez de adivinar.
- **Nota ilegible.** Desde el menú contextual el editor se abre con la nota
  vacía y pide la real. Si esa lectura fallaba, el diálogo se desbloqueaba y
  guardar borraba la nota. Ahora los campos y el botón Guardar siguen
  bloqueados (también con Intro), y un aviso explica por qué.
- **Reabrir con otra tarea abierta en el mismo hilo.** Antes se mostraba el
  error crudo de SQLite. Ahora se explica qué hacer. Marcar una tarea que ya
  no existe es un error, no un éxito silencioso.
- **Cuenta eliminada.** Sus tareas seguían en la lista apuntando a una cuenta
  que ya no existe. Ahora se eliminan con ella.
- Una fila ilegible de la lista es un error que se informa, no una tarea que
  desaparece sin aviso.

## Pendiente de decisión: datos que quedan al eliminar una cuenta

`store::delete_account` no borra estas tablas, que tienen columna de cuenta:

| Tabla | Contenido |
|---|---|
| `local_drafts`, `scheduled_sends`, `outgoing_attempts` | Borradores, envíos programados e intentos de envío |
| `rules`, `rule_log` | Reglas y su registro |
| `people`, `contact_sources`, `correspondents` | Contactos y libretas |
| `snoozed_threads`, `thread_labels`, `label_links` | Estado por conversación |
| `sender_priority`, `sender_spam`, `spam_triggers`, `spam_judgments` | Prioridad y spam |
| `oof_replied`, `calendar_reminders_fired` | Registros de respuestas automáticas y recordatorios |

Algunas pueden conservarse a propósito. Por ejemplo, un borrador sin enviar
es contenido del usuario, y un intento de envío incierto es evidencia de #29.
Otras son datos personales que ya no tienen dueño visible. Hace falta decidir,
tabla por tabla, qué se borra y qué se ofrece exportar antes de borrar.

## Fuera de alcance

Tareas independientes, sincronización CalDAV/Exchange de tareas y el
seguimiento de «esperando respuesta» (#103) necesitan su propio ADR.
