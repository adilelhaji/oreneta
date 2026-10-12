# Tareas en un servidor CalDAV (#103, ADR-0039)

## Uso

En **Tareas**:
- «Lista de tareas CalDAV…» pide el servidor, el usuario y la contraseña,
  y luego busca las colecciones. Se elige una y el nombre que tendrá aquí.
  La lista se lee una vez antes de añadirla; si falla, el diálogo sigue
  abierto con el motivo.
- Al abrir Tareas se sincronizan todas las listas enlazadas. Una lista
  enlazada muestra:
  - dónde se guarda;
  - la última sincronización;
  - las tareas en conflicto;
  - el último error, con «no se ha perdido nada»;
  - el botón **Sincronizar**.
- Una tarea en conflicto lleva la marca «Conflicto», el motivo
  («cambiada aquí y en el servidor», «borrada en el servidor», «borrada
  aquí y cambiada en el servidor») y dos botones: «Conservar la mía» y
  «Usar la del servidor».
- Una tarea que se repite se marca como tal y no se edita aquí.
- El editor no deja mover una tarea entre una lista del servidor y otra, y
  dice por qué.
- Borrar una lista enlazada avisa de que no se borra nada en el servidor.

## Núcleo

- Código: `meron-core/src/task_sync/`, con `vtodo.rs` para la lectura y
  escritura de VTODO. `calendar::caldav::fetch_todos` comparte con
  `fetch_window` la lectura «todo o nada».
- RPC:
  - `tasks.caldavDiscover {server, username, password}`;
  - `tasks.caldavAdd {url, name, server, username, password}`;
  - `tasks.sync {list_id?}`: sin `list_id` sincroniza todas. Responde
    `{lists: [{id, ok, error?, report?}]}` y nunca falla por un servidor;
  - `tasks.resolveConflict {id, keep: "mine"|"server"}`, que sincroniza
    después.
- Órdenes ampliadas:
  - `tasks.list` devuelve `pending`, `conflict` y `recurring`;
  - `tasks.lists` devuelve `remote_url`, `remote_user`, `synced_at`,
    `last_error` y `conflicts`;
  - `tasks.deleteList` borra también la contraseña.
- Esquema 56.
- Llavero: `caldav-tasks:{lista}`, incluido en
  `profile_purge::secret_names`.
- Puente: las cuatro órdenes pasan sin cambios. `tasks.sync` tiene 5
  minutos y las otras tres, 60 segundos.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 Rust VTODO (`task_sync/vtodo/tests.rs`) | Lectura de otro cliente (zona, prioridad, alarma relativa a `DUE`); una edición cambia solo lo cambiado y conserva X-, `CATEGORIES`, `RELATED-TO`, `VTIMEZONE`, `PERCENT-COMPLETE`, alarmas; `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED`; prioridad en los dos sentidos (5 se conserva si sigue siendo normal); fecha sola como medianoche local y escrita como fecha; completar y reabrir; alarmas sustituidas solo si cambia el recordatorio; tarea nueva completa con escapes; tarea que se repite leída y no editada; objeto sin tarea rechazado; plegado de líneas largas. Pasan con `TZ` de Nueva York, Calcuta y Chatham |
| N1 Rust sincronización (`task_sync/tests.rs`, servidor falso) | Primera lectura importa; edición local con `If-Match` que conserva lo ajeno; completar y borrar (lápida oculta, luego `DELETE` con `If-Match`); tarea nueva con `If-None-Match` y UID `@oreneta`, sin duplicar al releer; cambio remoto tomado y revisión subida; cambio en los dos lados en conflicto sin sobrescribir ninguno; un 412 detiene la cola de esa lista y no la de otra, y sigue detenida mientras dure el conflicto; borrado remoto quita la tarea sin cambios y deja en conflicto la cambiada; un objeto que no vuelve o no se lee no cambia nada y deja el error; la contraseña nunca sale del servidor (respuesta con otro origen, dirección local manipulada, enlace a HTTP desde HTTPS, colección ya enlazada); resolver con la del servidor y con la mía (sobre la versión actual y creándola de nuevo si se borró); borrar la lista no envía nada; mover y editar una tarea que se repite se rechaza; un recordatorio pasado al importar no suena |
| N1 despachador (`main.rs`) | Servidor inalcanzable: `tasks.caldavAdd` no añade nada; `tasks.sync` responde el error, la lista lo guarda y la tarea sigue pendiente; `tasks.resolveConflict` sin conflicto falla; borrar la lista |
| N1 guardas | `profile_purge` nombra el secreto nuevo y cuenta 12 escrituras; esquema 56 en las pruebas de migración |
| N2 (`CalDavTaskLists.test.tsx`) | Añadir una lista: buscar, elegir colección, nombre y alta; un fallo al añadir deja el diálogo abierto con el motivo; sincroniza al abrir solo si hay listas enlazadas; error de sincronización visible y botón Sincronizar; «Conservar la mía» y «Usar la del servidor»; mover entre listas rechazado sin guardar |
| N3 Radicale (`integration_caldav_tasks_test.go`) | Descubrir y añadir, edición que conserva lo ajeno, conflicto con nada escrito y «Conservar la mía», tarea nueva creada y borrar la lista sin tocar el servidor. Probado contra Radicale 3.5.4 local; en CI corre con la imagen Docker del arnés |
| N5 pendiente | Nextcloud, Fastmail e iCloud antes de anunciarlos |
