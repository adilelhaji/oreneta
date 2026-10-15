# Chat (#110, #111)

Registro de la implementación de ADR-0036, ADR-0044 (grupos y archivos) y
ADR-0055 (presencia, menciones, avisos y privados en grupos, #208).

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
- **Presencia, menciones, avisos y privados (ADR-0055, sin esquema
  nuevo):**
  - `chat/presence.rs`: el estado propio en la fila de ajustes
    `chat_presence:<cuenta>`; `plan` decide anunciar, ocultar (XEP-0186) o
    no anunciar nada; los contactos (mejor dispositivo), las peticiones y
    quién está en cada grupo, en `Live`, compartido con la app y solo en
    memoria; `should_notify` y el evento de aviso;
  - `chat/mentions.rs`: el apodo como palabra entera o una referencia
    XEP-0372 a nosotros; las referencias de los apodos elegidos al enviar;
  - `chat/xmpp.rs`: disco#info del servidor en cada conexión, el estado al
    conectar y al cambiarlo (a los grupos, solo la disponibilidad), las
    peticiones, quién entra y sale de cada grupo, el apodo que el grupo nos
    da (210), los privados (`grupo/apodo`, tipo `private`) y el aviso de lo
    llegado en directo;
  - RPC `chat.presence/setPresence/subscribe/answerSubscription/occupants`;
    `chat.send` acepta `mentions`; eventos `chat.own`, `chat.presence`,
    `chat.subscription`, `chat.occupants` y `chat.notify`;
  - en Go, `chat.notify` sale como notificación del sistema salvo con «No
    molestar» u horas tranquilas (como el correo); al pulsarla
    (`chat:<conversación>`) se abre en la vista Chat.
- **Aplicación:** la vista «Chat» en la barra lateral (configuración,
  conversaciones con no leídos, historia con el estado de cada envío y
  «Enviar de nuevo»). Con ADR-0044: «Unirse a un grupo», los grupos
  encima de las conversaciones directas, el apodo de quien habla, el
  estado de la sala, «Salir del grupo» con confirmación, las invitaciones
  como propuesta, el clip para enviar un archivo con su progreso y
  «Cancelar», y los archivos recibidos con su nombre y «Guardar…». Con
  ADR-0055: «Tu estado» y su texto (Invisible desactivado si el servidor no
  puede), las peticiones con «Permitir» y «Rechazar», el estado de cada
  contacto en la lista y en la cabecera o «Pedir ver su estado», en un grupo
  «Personas en el grupo» con «Escribir en privado», el apodo de quien habla
  para escribirle en privado, las sugerencias al escribir `@` (lista
  accesible: flechas, Intro o Tab, Escape) y «Te menciona» resaltado; los
  privados como «apodo (grupo)» (`lib/chatMentions.ts` decide la
  sugerencia).

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
    enlace, rechazados), sin escribir nada.
- **Presencia, menciones, avisos y privados (ADR-0055):**
  - el estado propio por cuenta: texto limpio y de 200 caracteres como
    mucho, un campo dañado vuelve solo a su valor, se olvida al quitar la
    cuenta;
  - invisible solo si el servidor lo anuncia; sin él, no se anuncia nada y
    nunca se pasa solo a visible;
  - a los contactos, disponibilidad y texto; a los grupos, sin texto;
  - el estado de un contacto es el de su mejor dispositivo; las peticiones
    esperan; una sesión nueva empieza de cero;
  - quién está en un grupo (llega, cambia de apodo, se va) y el apodo que
    nos da el grupo;
  - una mención: palabra entera, sin distinguir mayúsculas, en cualquier
    alfabeto, no dentro de otra palabra, o por referencia; las referencias
    que salen, una por apodo que sigue en el texto, contadas en caracteres;
  - al leer un grupo solo se marca lo que nombra a la persona;
  - avisa solo lo nuevo, de otro y en directo: no lo repetido, lo retrasado,
    lo del archivo, lo propio, un grupo sin mención ni nada con «Ocupado»;
  - un privado es su propia conversación (lista, no leídos, eco desde otro
    dispositivo, error devuelto, mayúsculas del apodo), no pide recibo y su
    id de archivo cuenta para ponerse al día; salir de un grupo borra sus
    privados y no los de otro grupo de nombre parecido.
- **Puente Go:** la notificación del chat lleva la conversación como
  destino y calla con «No molestar» u horas tranquilas aunque los
  recordatorios pasen; un evento sin cuenta o sin conversación no avisa.
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
    se rechaza antes de subir; uno cancelado no sale;
  - (ADR-0055, usuarios `eva` y `joan` solo para esto) Eva pide ver el
    estado de Joan y nada llega hasta que Joan lo permite; luego ve
    «Ausente — Comiendo» y «Ocupado»; Joan no ve el de Eva; ocupado, un
    mensaje se guarda sin aviso y, disponible, avisa; Prosody no ofrece
    invisible: Joan «invisible» queda sin anunciar (Eva lo ve desconectado),
    lo escrito mientras llega una vez al volver y sin aviso;
  - en un grupo, cada uno sabe quién está; la mención llega marcada y avisa,
    lo demás no; un privado a `grupo/Ana` llega a Ana como «Pau» aparte del
    grupo y con aviso, la respuesta llega a Pau y queda aceptada; salir
    borra el privado.
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
    uno por http no se ofrece para guardar;
  - (ADR-0055) el estado y su texto; Invisible desactivado o con su
    explicación; el aviso de «no se anuncia nada»; pedir ver un estado,
    permitir y rechazar, solo al pulsar; el estado del contacto, y nada sin
    conexión; en un grupo, las sugerencias de `@` (sin la persona, flechas,
    Intro, Escape, no tras una dirección), las menciones enviadas, «Te
    menciona» solo donde toca y quién está; un privado listado y abierto,
    con su apodo en mayúsculas, y abierto desde un nombre del grupo; pulsar
    una notificación abre su conversación en Chat.
- **Encontrado al probar:** la auditoría axe vio un elemento que no era
  `li` dentro de la lista de mensajes; corregido. Con ADR-0044, el núcleo
  aceptaba copias de carbons y resultados de archivo de cualquier
  remitente; ahora solo del propio servidor (o de una sala unida, para su
  archivo).
