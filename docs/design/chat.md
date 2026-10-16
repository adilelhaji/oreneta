# Chat (#110, #111)

Registro de la implementación de ADR-0036 y ADR-0044 (grupos y archivos).

## Piezas

- **Núcleo:**
  - `meron-core/src/chat/`: el almacén (`chat_accounts`, `chat_messages`,
    `chat_reads`, esquema 54, con columna propia `chat_account`) y
    `xmpp.rs`, con el conector sobre `crate::tls`, la interpretación de
    stanzas y la sesión (archivo por páginas, carbons, recibos y ack);
  - RPC `chat.accounts/status/save/remove/conversations/history/markRead/send/retry`;
  - eventos `chat.changed` y `chat.status`;
  - las cuentas se conectan al arrancar.
- **Grupos y archivos (ADR-0044, esquema 58):**
  - tablas `chat_rooms` y `chat_invitations`; en `chat_messages`, `kind`
    (`chat` o `groupchat`) y el archivo (`file_url`, `file_name`,
    `file_size`);
  - `chat/xmpp.rs`: entrada a salas con historia, eco propio sin
    duplicar, archivo de la sala, invitaciones y la subida (búsqueda del
    servicio, sitio, `PUT` y mensaje con OOB);
  - `chat/files.rs`: solo HTTPS, nombre seguro, límite del servicio,
    subida con progreso y cancelación, y descarga a petición;
  - RPC `chat.rooms/join/leave/invitations/dismissInvitation`,
    `chat.sendFile/cancelUpload/download`; en Go, `chat.pickFile` y
    `chat.saveFileAs` (diálogos del sistema);
  - eventos `chat.room`, `chat.invitation`, `chat.progress` y
    `chat.uploaded`; la contraseña de una invitación se queda en el núcleo
    (llavero) y no llega a la vista.
- **Aplicación:** la vista «Chat» en la barra lateral (configuración,
  conversaciones con no leídos, historia con el estado de cada envío y
  «Enviar de nuevo»). Con ADR-0044: «Unirse a un grupo», los grupos
  encima de las conversaciones directas, el apodo de quien habla, el
  estado de la sala, «Salir del grupo» con confirmación, las invitaciones
  como propuesta, el clip para enviar un archivo con su progreso y
  «Cancelar», y los archivos recibidos con su nombre y «Guardar…».

## Pruebas

- **Almacén:**
  - un mensaje una vez por id o por id de archivo;
  - estados solo hacia delante y uno perdido queda incierto sin reenviarse;
  - el archivo lo da por aceptado;
  - no leídos y lectura que no retrocede;
  - aislamiento entre cuentas y borrado.
- **Stanzas:**
  - mensaje entrante y propio desde otro dispositivo;
  - un id de archivo falsificado por otro servidor se ignora;
  - grupo, error y vacíos no cuentan;
  - lo que se envía lleva `origin-id` y pide recibo.
- **Grupos e invitaciones (ADR-0044):**
  - la entrada pide historia (desde el último mensaje o los 50 últimos) y
    lleva la contraseña;
  - el apodo de quien habla, y solo cuenta el `stanza-id` de la sala;
  - la sala sin apodo, otra sala y el cambio de tema no son mensajes; la
    lectura directa no toma mensajes de grupo;
  - lo que se envía a una sala es `groupchat` con `origin-id` y sin
    pedir recibo;
  - el eco propio, también desde el archivo con otro apodo, se guarda una
    vez y queda aceptado; un grupo no es conversación directa ni su
    archivo el de la cuenta;
  - lista de salas con no leídos; salir borra lo de aquí; quitar la cuenta
    borra salas e invitaciones; el paso del esquema se puede repetir;
  - invitación directa (con contraseña) y a través de la sala; no se
    guarda para una sala ya unida ni más de 20;
  - lo que dice la sala de nuestra entrada (dentro, sala nueva, error de
    contraseña).
- **Archivos (ADR-0044):**
  - servicio de subida y su límite desde disco#info; uno mayor se rechaza
    antes de subir;
  - petición y respuesta del sitio; un sitio por HTTP no se usa;
  - el enlace sale en el cuerpo y como OOB y vuelve como archivo con su
    nombre decodificado; un nombre no sale de su carpeta;
  - solo HTTPS al subir y al guardar (http, ftp, file, credenciales en el
    enlace, rechazados), sin escribir nada;
  - una pregunta sin respuesta termina en su plazo; una búsqueda sin
    servicio termina las subidas que esperan con «sin servicio» o, si una
    pregunta quedó sin respuesta, con `disconnected` (#220).
- **tokio-xmpp parcheado (#220):** un receptor consultado mientras se
  envía algo vuelve a despertarse (`third_party/tokio-xmpp`, en CI); sin el
  parche, la prueba falla.
- **Llavero:** las contraseñas de salas e invitaciones están en
  `secret_names` y el contador de escrituras de secretos sube a 13.
- **Prosody real** (`tests/prosody-xmpp.sh`, también en CI):
  - entrega en directo con recibo;
  - con el destinatario desconectado, el mensaje llega desde el archivo una
    sola vez, también tras volver a conectar otra vez;
  - dos personas en una sala nueva: cada una oye a la otra con su apodo,
    el eco propio queda aceptado una vez con el id de la sala, y quien
    vuelve entra solo otra vez y recibe lo dicho mientras tanto una sola
    vez, dos veces seguidas; salir deja la sala;
  - un archivo de 300 KB por `mod_http_file_share` sobre HTTPS (autoridad
    de pruebas creada por el script, `ORENETA_PROSODY_CA`): progreso,
    enlace recibido con su nombre y guardado idéntico; uno de más de 1 MiB
    se rechaza antes de subir; uno cancelado no sale.
- **Aplicación:**
  - lista con no leídos, estados visibles;
  - «Enviar de nuevo» solo al pulsar, con el mismo id;
  - envío con Intro;
  - lectura al llegar en la conversación abierta;
  - alta de cuenta;
  - unirse a un grupo con apodo y contraseña, y abrirlo;
  - en un grupo, el apodo de cada uno, su estado, escribir en él y salir
    con confirmación;
  - una invitación se ofrece y solo se entra al pulsar; «Ahora no»;
  - enviar un archivo con progreso, cancelar, y el aviso de demasiado
    grande;
  - un archivo recibido con su nombre y «Guardar…», sin descargarse solo;
    uno por http no se ofrece para guardar.
- **Encontrado al probar:** la auditoría axe vio un elemento que no era
  `li` dentro de la lista de mensajes; corregido. Con ADR-0044, el núcleo
  aceptaba copias de carbons y resultados de archivo de cualquier
  remitente; ahora solo del propio servidor (o de una sala unida, para su
  archivo). Con #220, las pruebas contra Prosody fallaban de vez en cuando
  (13 de 300 rondas): tokio-xmpp 6.0.0 perdía el aviso de su receptor si
  se le consultaba mientras se enviaba algo, y la sesión dejaba de recibir
  sin desconectarse. Se usa una copia parcheada (`third_party/tokio-xmpp`)
  y las preguntas de una subida tienen plazo.
