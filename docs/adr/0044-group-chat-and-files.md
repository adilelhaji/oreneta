# ADR-0044: Grupos y archivos en el chat (XMPP)

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Enmienda: el 2026-10-16, #220 da a cada pregunta de una subida un plazo
  de 30 s; sin respuesta, la subida termina con `disconnected`. También
  precisa que el servicio se busca hasta encontrarlo. El resto de la
  decisión no cambia.
- Fecha: 2026-10-12.
- Alcance: lo que ADR-0036 dejó pendiente de #111: grupos (MUC, XEP-0045) y
  archivos (HTTP File Upload, XEP-0363) con progreso y cancelación.

## Decisión

- **Unirse a un grupo:**
  - por su dirección (`sala@servicio.ejemplo`) y un apodo; la contraseña
    de la sala, si la tiene, va al llavero (`chat-room:<cuenta>:<sala>`),
    nunca al almacén;
  - la sala se guarda (`chat_rooms`, esquema 58) y se vuelve a entrar en
    cada conexión nueva; una sesión reanudada (XEP-0198) sigue dentro y no
    entra otra vez;
  - una sala nueva se acepta con la configuración por omisión («sala
    instantánea»), para que otros puedan entrar;
  - lo que diga la sala de nuestra entrada (dentro, fuera, contraseña
    errónea, apodo ocupado, solo miembros, vetado, no existe, llena) llega
    a la vista como estado de la sala, no como error genérico.
- **Historia de un grupo:**
  - al entrar se pide a la sala lo dicho desde el último mensaje guardado
    aquí (`<history since>`), o los 50 últimos si no hay nada;
  - si ya conocemos un id del archivo de la sala, se recorre además su
    archivo (XEP-0313 contra la dirección de la sala), por páginas;
  - solo cuenta el `stanza-id` que pone la sala (`by` igual a la sala);
    uno puesto por otro se ignora, como en el chat directo;
  - el id de archivo de una sala no se mezcla con el de la cuenta: cada
    conversación tiene el suyo.
- **Un mensaje se guarda una vez** también en un grupo: por su `origin-id`
  o su id, y por el `stanza-id` de la sala. Lo propio que la sala devuelve
  (eco) no es un mensaje nuevo: confirma el enviado y lo pasa a «aceptado».
  Se reconoce por el apodo o, si el apodo cambió, porque ese id salió de
  aquí.
- **Quién dijo qué:** cada mensaje de un grupo guarda el apodo de quien
  habla; la sala hablando sin apodo y los cambios de tema no son mensajes.
- **Estados en un grupo:** enviando → enviado → aceptado (ack XEP-0198 o
  eco de la sala). No se pide recibo de entrega en un grupo. Un error
  devuelto para un id nuestro lo deja en «no enviado». Tras una
  desconexión, lo no confirmado queda en «puede que no haya llegado» y no
  se reenvía solo, igual que en el directo.
- **Salir:** la sala deja de entrarse, se borra la contraseña del llavero y
  lo guardado aquí de ella. El archivo de la sala no se toca.
- **Invitaciones:**
  - directas (XEP-0249) o a través de la sala (XEP-0045); se guardan
    (`chat_invitations`) y se muestran como propuesta;
  - entrar es decisión de la persona: «Unirse…» abre el mismo formulario,
    con la dirección ya puesta, y «Ahora no» la aparta;
  - una contraseña que traiga la invitación va al llavero; la vista solo
    sabe que existe;
  - como mucho 20 invitaciones esperando por cuenta; otra más, o una para
    una sala en la que ya se está, no se guarda.
- **Enviar un archivo:**
  - el servicio de subida se busca en el servidor de la cuenta (disco#info
    del dominio y de sus elementos) hasta encontrarlo; encontrado, sirve
    para el resto de la sesión;
  - el límite de tamaño es el del formulario del servicio (`max-file-size`):
    un archivo mayor se rechaza aquí, antes de pedir sitio y sin enviar
    nada;
  - se pide un sitio (slot) con nombre y tamaño, y tanto el `PUT` como el
    `GET` deben ser HTTPS; si no, no se usa;
  - el archivo se sube con `PUT` por HTTPS, con el proxy de la app y sin
    seguir redirecciones; solo pasan las cabeceras que permite XEP-0363;
  - el progreso llega cada 256 KB (`chat.progress`) y el final una vez
    (`chat.uploaded`); cancelar corta el envío y no sale ningún mensaje;
  - cada pregunta de la subida (el servicio, el sitio) espera como mucho
    30 s (#220): un sitio sin respuesta termina la subida con
    `disconnected`; una búsqueda que acaba sin servicio la termina con
    `noService`, o con `disconnected` si alguna pregunta quedó sin
    respuesta, y la siguiente subida vuelve a buscar;
  - subido, el enlace sale como mensaje normal, con el enlace en el cuerpo
    y como OOB (XEP-0066), y sigue las reglas de estado de siempre;
    «Enviar de nuevo» vuelve a mandar el mismo enlace con el mismo id.
- **Recibir un archivo:**
  - un mensaje con enlace OOB se muestra como archivo, con su nombre
    (último tramo de la ruta, decodificado y sin barras ni puntos al
    principio) y «Guardar…»;
  - nunca se descarga solo: solo cuando la persona elige dónde guardarlo;
  - solo por HTTPS, sin credenciales en el enlace y sin redirecciones; se
    escribe al lado con `.part` y se renombra al terminar.

## Alternativas descartadas

- **Pedir siempre a la sala su historia completa por MAM:** no todas las
  salas tienen archivo y el primer acceso traería meses. La historia de la
  sala desde el último mensaje, y el archivo solo para rellenar huecos,
  basta.
- **Guardar la contraseña de la invitación en el almacén o en memoria:** el
  almacén no guarda secretos (ADR-0036) y en memoria se perdería al
  reiniciar.
- **Descargar los archivos recibidos para previsualizarlos:** sería tráfico
  hacia servidores de otros sin que la persona lo pida.
- **Cliente HTTP propio sobre `crate::tls` para el certificado fijado:** el
  servicio de subida suele ser otro nombre que el servidor XMPP, así que el
  certificado fijado de la cuenta no le corresponde; se usa ureq, como en
  #108, con las raíces habituales y el proxy de la app.

## Pendiente (#111 sigue abierta)

- Mensajes privados dentro de una sala: hoy se ignoran.
- Invitar a otros desde aquí, cambiar de apodo y la lista de ocupantes.
- Cifrar archivos (XEP-0454) y miniaturas.
- Presencia, menciones y notificaciones del sistema.
- Rocket.Chat; Teams y Slack cuando existan los registros.
- N5: un servidor XMPP público con dos cuentas de prueba, también para
  grupos y archivos.
