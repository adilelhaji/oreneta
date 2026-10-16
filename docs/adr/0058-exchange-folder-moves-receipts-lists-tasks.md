# ADR-0058: Exchange (EWS): mover carpetas, confirmación de entrega, listas de distribución y tareas

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #211 y pidió la opción más prudente); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #211, la parte de Exchange (EWS) de cuatro filas de la paridad
  con eM Client 10.4: SET-07 (#87, mover carpetas), SET-11 (#107,
  confirmación de entrega), SET-19 (#41, grupos de contactos) y SET-20
  (#103, tareas). Sobre ADR-0012, ADR-0013, ADR-0039, ADR-0048, ADR-0050,
  ADR-0052 y ADR-0053. Microsoft Graph queda fuera (#210), y también la
  evidencia con un servidor Exchange real (la ejecución N5 final).

## Contexto

El adaptador EWS ya leía y movía correo, el calendario, el directorio y la
respuesta automática. Le faltaban cuatro cosas que IMAP, CalDAV y CardDAV
ya tienen: mover una carpeta, pedir confirmación de entrega, los grupos de
contactos y las tareas. El crate `ews` (bifurcación propia) modela
`MoveFolder` y `IsDeliveryReceiptRequested`, pero da a todos los elementos
una sola forma (`Message`) sin miembros, fecha de vencimiento ni estado de
tarea, y no se puede cambiar sin publicar una versión nueva del crate.

## Decisión

### 1. Mover carpetas (SET-07)

- **Las carpetas de EWS se nombran por su ruta.** Hasta ahora el nombre de
  cable de una carpeta era solo su nombre, así que «Bandeja de
  entrada/Clientes» era `Clientes`, todas salían al nivel superior y dos
  subcarpetas con el mismo nombre se pisaban. Ahora el nombre es la ruta
  desde la raíz del buzón, con `/` como en IMAP: `INBOX/Clientes`,
  `Proyectos/2026`. La raíz no se lista; una carpeta cuyo padre no está en
  la lista (la raíz, o una carpeta de otra clase) empieza una ruta. Una
  carpeta de servicio que no es de correo sigue sin listarse, pero sí da
  su sitio a las suyas que lo son. Una cadena de padres que vuelve sobre
  sí misma (error del servidor) se corta donde se repite.
- **Una `/` dentro de un nombre de Exchange** se escribe como `∕` (barra de
  división, U+2215), que se lee igual: Exchange la admite en un nombre y la
  ruta la usa entre nombres. Para que dos nombres nunca den lo mismo (`A/B`
  y `A∕B`), una `∕` que ya está en el nombre se escribe `\∕` y una barra
  invertida `\\`: cada tramo se lee de vuelta como un solo nombre. Como
  los nombres por ruta llegan con este mismo cambio, no hay nombres
  guardados con otra forma que convertir.
- **Todo lo guardado con el nombre antiguo sigue a su carpeta.** Al listar,
  lo que estaba guardado con el nombre de antes (sin ruta) de una carpeta
  que era la única con ese nombre, y cuya ruta aún no tiene nada, pasa a la
  ruta nueva en una transacción, igual que en un movimiento: mensajes,
  estado de sincronización, ids de Exchange, conversaciones pospuestas,
  tareas hechas de una conversación, el registro de las reglas, el progreso
  del archivado automático, las reglas de la cuenta que mueven correo allí
  y la política de archivado automático (que sigue confirmada: nombra las
  mismas carpetas). Nada se vuelve a descargar. Una prueba recorre todas
  las columnas que nombran una carpeta y falla si una nueva no está
  decidida (`folder_move::FOLDER_REFERENCES` o `NOT_MAIL_FOLDERS`). Las
  reglas «para todas las cuentas» conservan su nombre: nombran una carpeta
  de cada cuenta, y cambiarlo para una rompería las demás.
- **La interfaz también lo sigue.** Los cambios de nombre quedan guardados
  (`folder_renames`) hasta que la interfaz pide la lista de carpetas, que
  los trae (`renames`, como al mover); favoritas, colores, columnas de los
  tableros, búsquedas guardadas, la carpeta abierta y la última abierta los
  siguen. No se quita ninguna favorita.
- **Un nombre que tenían varias carpetas** (`Archivo` arriba y
  `Bandeja de entrada/Archivo`) mezclaba las dos en la caché: se borra esa
  caché y ambas se leen de nuevo. Todo esto pasa una sola vez por cuenta, la
  primera vez que se listan sus carpetas con esta versión
  (`ews_folder_paths`); después, una carpeta nueva que se llama como otra
  es solo una carpeta nueva. Lo que nombraba ese nombre se queda en la
  que sigue llamándose así, o deja de encontrar su carpeta: no se puede
  saber cuál era.
- **Un estado de sincronización que el servidor ya no acepta**
  (`ErrorInvalidSyncStateData`) vuelve a empezar la carpeta, una vez.
- **Mover es `MoveFolder`** con el id de la carpeta y el del padre nuevo
  (o la raíz del buzón, `msgfolderroot`, para el nivel superior); las
  subcarpetas y los elementos van con ella. Las reglas de ADR-0050 son las
  mismas (`folder_move::plan_folder_move` sobre la lista guardada).
- **Antes de mover se vuelve a listar la jerarquía.** Si la carpeta ya no
  está donde decía la caché (movida, renombrada o borrada en otro
  cliente), si el destino ya no existe o si allí ya hay una carpeta con ese
  nombre, no se mueve nada y se pide refrescar. Es la regla de ADR-0012
  aplicada a carpetas: nunca actuar sobre una imagen del buzón que ya no
  es cierta.
- **Nunca se repite.** Antes de enviarlo se guarda el movimiento con el id
  de la carpeta y todos sus cambios de nombre (`ews_uncertain_moves`). Si
  el servidor contesta, el registro se borra (hecho, o rechazado: nada se
  movió). Si la respuesta se pierde, la sesión olvida su lista y la
  siguiente lectura de carpetas busca la carpeta por su id: si está en la
  ruta nueva, todo lo guardado con los nombres viejos la sigue, como tras
  un movimiento contestado, y la interfaz se entera; si sigue donde
  estaba, no se movió; en ambos casos el registro se borra.
- La interfaz deja mover carpetas en cuentas de Exchange; Graph sigue
  desactivado hasta #210.

### 2. Confirmación de entrega (SET-11)

- Exchange recibe el mensaje como MIME (`CreateItem` con `MimeContent` y
  `SendAndSaveCopy`), sin sobre SMTP. La petición va en el propio elemento,
  junto al contenido: `IsDeliveryReceiptRequested` = `true`. Las
  propiedades del elemento se aplican sobre el MIME.
- Solo se escribe si quien envía la pidió (ADR-0048: el interruptor del
  redactor, que empieza con el ajuste global). Sin pedirla, la petición al
  servidor no cambia en nada.
- El envío responde `delivery_receipt: "requested"` para Exchange: la
  petición va en la solicitud. Que un servidor Exchange real la atienda
  junto al MIME no está comprobado todavía (N5); hasta entonces la
  documentación dice «se pide en la solicitud» y la interfaz no promete
  más. Graph sigue respondiendo `"unsupported"` hasta #210: dicho, no
  escondido.
- La confirmación de lectura sigue en la cabecera MIME
  (`Disposition-Notification-To`), como decía ADR-0048; no se duplica en
  `IsReadReceiptRequested`.
- Interpretar los avisos de entrega que llegan es de #210.

### 3. Listas de distribución como grupos de contactos (SET-19)

- **Una libreta por cuenta de Exchange** (`exchange-<cuenta>`, tipo
  `exchange`), como la de Google: se trae desde Ajustes → Personas con
  «Leer los contactos de Exchange» y se vuelve a leer como las demás. Usa
  el inicio de sesión de la cuenta; no guarda contraseña propia. Se va con
  la cuenta.
- **Personas:** los contactos de la carpeta Contactos (no sus subcarpetas),
  de solo lectura, como dice ADR-0012 para Exchange. El nombre, nombre de
  pila, apellido, empresa, direcciones (sin prefijo `SMTP:`; un
  identificador de directorio `/O=…` no es una dirección) y teléfonos.
- **Grupos:** cada lista de distribución de la carpeta es un grupo
  (ADR-0052). Sus miembros:
  - un contacto de la carpeta, por su id de elemento, que es el UID de la
    persona en la libreta;
  - alguien que no es contacto aquí (una dirección escrita o una entrada
    del directorio) se guarda como `mailto:<dirección>` con el nombre y la
    dirección que dio el servidor (columnas nuevas `name` y `addr` de
    `contact_group_members`, esquema 65). Se ve en el grupo y el redactor
    lo expande igual que a un contacto. Sin esto, una lista hecha con el
    directorio de la organización (lo habitual) se vería vacía;
  - una entrada sin dirección utilizable (una lista dentro de la lista, un
    identificador de directorio) no se muestra, pero sigue en la lista.
- **Escribir** (crear, renombrar, añadir o quitar miembros, borrar), con la
  regla de ADR-0012:
  - se lee la lista del servidor; si su clave de cambios (`ChangeKey`) no
    es la leída, no se escribe nada y se devuelve la copia de allí;
  - se envía solo la diferencia sobre lo que el editor veía: el nombre si
    cambió (`SetItemField`), los miembros nuevos (`AppendToItemField`) y
    los que se quitan, por la clave que el servidor dio a cada uno
    (`DeleteItemField` sobre `distributionlist:Members:Member`). Un miembro
    que el editor no veía no se toca;
  - la escritura lleva la clave leída y
    `ConflictResolution="NeverOverwrite"`: un cambio hecho entre la lectura
    y la escritura lo rechaza el servidor
    (`ErrorIrresolvableConflict`) y se devuelve la copia de allí;
  - borrar una lista la manda a Elementos eliminados, tras comprobar su
    clave como arriba (`DeleteItem` no compara claves);
  - tras escribir se vuelve a leer la lista y se guarda tal como quedó;
    un conflicto también guarda aquí la copia de allí (o quita la lista si
    ya no está), así que «mírala otra vez y reinténtalo» parte de ella;
  - nunca se escribe sin la clave leída: sin ella no se envía nada y es un
    conflicto.
- **Límite aceptado:** crear una lista no es idempotente. Si la respuesta a
  la creación se pierde, la lista puede quedar creada en el servidor y
  aparecer en la siguiente lectura de la libreta; volver a crearla a mano
  haría una segunda. Las listas no tienen dónde guardar un id nuestro que se
  pueda buscar, como las tareas, y buscar por nombre confundiría dos listas
  que se llaman igual.
- Un grupo de Exchange solo puede tener personas de la misma libreta, como
  uno de CardDAV. Un miembro nuevo que es contacto se escribe por su id y su
  primera dirección; una persona sin dirección no puede entrar.

### 4. Tareas (SET-20)

- **Una lista por cuenta de Exchange**, enlazada a su carpeta Tareas: «Tareas
  de Exchange de <cuenta>» en la vista de Tareas. Columna nueva
  `task_lists.ews_account` (esquema 65). Se lee entera antes de añadirla; si
  falla, no se añade. Se va con la cuenta (y sus tareas). El resto del
  modelo es el de ADR-0039: cambios aquí primero, marcados como pendientes;
  se sincroniza al abrir Tareas y con «Sincronizar».
- **Correspondencia de campos:** `Subject` ↔ título; `Body` en texto ↔ nota;
  `Importance` ↔ prioridad (baja, normal, alta); `DueDate` ↔ fecha límite,
  que en Exchange es una fecha sin hora: se lee el día que nombra, en la
  zona en que Exchange escribió su medianoche (como los eventos de día
  entero), y es la medianoche de aquí; se escribe como `AAAA-MM-DDT00:00:00Z`.
  Una hora de vencimiento puesta aquí no viaja: Exchange no la guarda.
  `Status` `Completed` con `CompleteDate` ↔ completada (nunca una fecha
  futura, que Exchange rechaza); reabrir escribe `NotStarted`.
  `ReminderIsSet` y `ReminderDueBy` ↔ recordatorio.
- **Escribir solo lo que cambió:** se guarda la copia del servidor tal como
  se leyó, y una edición envía solo las propiedades que difieren
  (`SetItemField`/`DeleteItemField`). Lo que otro cliente puso y aquí no se
  ve (categorías, trabajo, propietario) no se toca.
- **Conflictos (ADR-0012, ADR-0039):** cada escritura lleva la clave de
  cambios leída y `NeverOverwrite`. Un rechazo marca la tarea en conflicto
  y detiene la cola de la lista; la lectura marca en conflicto una tarea
  cambiada en los dos lados o cambiada aquí y borrada allí. «Conservar la
  mía» vuelve a poner la tarea en cola sobre la versión de allí (o la crea
  de nuevo); «Usar la del servidor» toma la de allí. Borrar comprueba la
  clave antes, porque `DeleteItem` no lo hace. Nunca se escribe sin la
  clave leída: sin ella es un conflicto y no se envía nada.
- **Un cambio que Exchange nunca aceptaría** («cada N años» con N > 1, una
  regla sin vencimiento) se sabe antes de enviar: esa tarea queda apartada
  con el motivo (`rejected: …`) y las demás de la lista siguen. Se vuelve a
  intentar cuando la tarea cambia. El editor tampoco ofrece «cada N años»
  en una lista de Exchange.
- **Lectura por páginas** en orden de creación; el desplazamiento cuenta
  todo lo que el servidor lista (la carpeta puede tener otras cosas) y una
  tarea listada dos veces es una. Como las páginas por desplazamiento
  pueden saltarse una tarea si otra desaparece entre dos páginas, una
  tarea conocida aquí que la lectura no trajo se pide por su id antes de
  darla por borrada; solo se borra aquí si el servidor dice que no
  existe. Cada lista se sincroniza de una en una;
  listas distintas no se esperan.
- **Sin duplicados al reintentar:** antes de crear una tarea se guarda aquí
  un id nuestro (`remote_href = new:<uuid>`) y se escribe en la tarea como
  propiedad con nombre (`PublicStrings`, `OrenetaTaskUid`). Si la respuesta
  se pierde, el siguiente intento busca ese id (`FindItem` con
  restricción) y adopta la tarea que encuentra en vez de crear otra; la
  lectura completa hace lo mismo. Es el equivalente de decidir la
  dirección antes de enviar en CalDAV (ADR-0039).
- **Repetición (ADR-0053), donde EWS la admite:** diaria, semanal (uno o
  varios días), mensual por día o por enésimo día de la semana
  (`RelativeMonthlyRecurrence`), anual por día o por enésimo día de la
  semana en el mes del vencimiento; sin fin, hasta una fecha o N veces. Se
  leen como regla RRULE explicitada y se escriben con `StartDate` = el
  vencimiento. Completar una ocurrencia hace lo mismo que en CalDAV: la
  tarea pasa a la siguiente ocurrencia (`DueDate`, `Recurrence` con lo que
  queda, `StartDate`) y se crea una copia completada sin regla. No se marca
  la serie como completada en el servidor, así que Exchange no genera
  ocurrencias por su cuenta.
- **Solo lectura:** una tarea con una regla que aquí no se escribe — las que
  se regeneran N días después de completarse, varios días de la semana en
  una regla mensual, «cualquier día laborable», anual en otro mes que el
  del vencimiento, o una regla sin vencimiento — se muestra y se puede
  borrar, pero no editar, con el aviso de ADR-0053. «Cada N años» con N > 1
  no existe en EWS (ver arriba).
- Mover una tarea entre una lista de Exchange y otra lista se rechaza, como
  con CalDAV.

### Común

- **SOAP escrito a mano** para listas y tareas (`exchange/soap.rs`): unas
  pocas operaciones (`FindItem`, `GetItem`, `CreateItem`, `UpdateItem`,
  `DeleteItem`) escritas como texto con los prefijos `m:` y `t:`, y la
  respuesta leída con `quick-xml` (ya era dependencia directa) por nombre
  local, como el lector WebDAV. Un fallo SOAP entero falla; un error por
  elemento se informa con su código.
- **Esquema 65** (el 64 es de #210, que entra antes):
  `contact_group_members.name` y `.addr`; `task_lists.ews_account`;
  `folder_renames`, `ews_folder_paths` y `ews_uncertain_moves`.

## Alternativas descartadas

- **Mover carpetas de Exchange sin cambiar los nombres (lista plana):** el
  movimiento no se vería y dos subcarpetas con el mismo nombre seguirían
  pisándose; la jerarquía hace falta igualmente.
- **Volver a descargar las subcarpetas en vez de llevar su caché a la ruta
  nueva:** más simple, pero baja otra vez todo su correo por un cambio de
  nombre.
- **Guardar los ids de carpeta de Exchange en la base de datos** para
  seguir cualquier renombrado hecho en otro cliente: es una tabla nueva
  para un caso que la siguiente sincronización ya resuelve (como en IMAP).
- **Ampliar el crate `ews`** con miembros y campos de tarea: obliga a
  publicar una versión nueva de la bifurcación; el SOAP escrito a mano es
  local, probado con respuestas grabadas y sin dependencias nuevas.
- **`ConflictResolution="AutoResolve"` o escribir la lista entera de
  miembros:** sobrescribiría el trabajo de otro cliente (ADR-0012).
- **Ocultar los miembros que no son contactos,** como hace ADR-0052 con los
  `mailto:` de CardDAV: en Exchange son la mayoría y las listas se verían
  vacías.
- **Marcar la serie como completada y dejar que Exchange genere la
  siguiente ocurrencia:** depende de un comportamiento del servidor que no
  se puede probar sin uno real; se hace igual que en CalDAV.
- **Crear tareas sin id propio y aceptar un duplicado si se pierde la
  respuesta:** contradice ADR-0039.

## Pendiente

- Evidencia con un servidor Exchange real (N5): que acepta
  `IsDeliveryReceiptRequested` junto al MIME, los miembros de tipo contacto
  escritos como se describe, y la conversión de `DueDate` en buzones con
  zona horaria negativa.
- Las subcarpetas de Contactos y otras carpetas de contactos o de tareas
  del buzón; buzones compartidos más allá del principal de la cuenta.
- Editar los contactos de Exchange (ADR-0012 los sigue dejando en solo
  lectura).
- Añadir a una lista de Exchange a alguien de otra libreta (como dirección
  suelta).
- Las tareas y listas de Exchange en el móvil.
- Microsoft Graph: mover carpetas y confirmación de entrega (#210); To Do y
  contactos de Graph.

## Pruebas

Todas con respuestas SOAP grabadas, sin servidor real:

- `exchange/tests/folder_moves.rs`: rutas, `/` en un nombre, cadena de
  padres en bucle, caché del nombre plano que sigue a su carpeta (y otra
  cuenta que no se toca), nombre compartido, movimiento (éxito, al nivel
  superior, servidor cambiado desde la caché, rechazo del servidor,
  respuesta perdida sin repetición, carpetas especiales).
- `exchange/tests/delivery_receipts.rs` y `main.rs`: la petición en el
  elemento, nada sin pedirla, rechazo, respuesta perdida; `requested` para
  Exchange y `unsupported` para Graph.
- `exchange/book/tests.rs` y `pim/exchange_book/tests.rs`: lectura de
  contactos y listas, lectura que falla entera, diferencia enviada, copia
  local obsoleta que no pisa el servidor, conflicto del servidor, error y
  respuesta perdida, crear y borrar, dos cuentas aparte.
- `exchange/tasks/tests.rs` y `task_sync/exchange/tests.rs`: campos, reglas
  leídas y escritas, solo lo cambiado, edición, conflictos y su
  resolución, error, creación con respuesta perdida sin duplicado,
  ocurrencia completada, borrado, dos cuentas aparte.
- `folder_move.rs`: todas las columnas que nombran una carpeta están
  decididas; tareas, pospuestas, registro, progreso de archivado, reglas de
  la cuenta y política confirmada siguen al cambio de nombre, y nada de otra
  cuenta; los cambios de nombre se leen una vez por cuenta.
- Frontend: `folderMoves.test.ts`, `folderMove.test.ts` (cambios de nombre
  de una lista de carpetas), `ExchangeGroups.test.tsx`,
  `ExchangeTaskLists.test.tsx`.
