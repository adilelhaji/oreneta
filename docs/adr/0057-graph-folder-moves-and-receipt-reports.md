# ADR-0057: Mover carpetas y pedir confirmación de entrega en Graph; leer los informes de entrega y de lectura

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #210: «la opción más prudente»); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #210, sobre las filas SET-07 (#87, carpetas) y SET-11 (#107,
  confirmaciones) del libro de paridad. Completa lo que ADR-0050 y ADR-0048
  dejaron pendiente para Microsoft Graph y añade leer los informes que
  llegan, en todos los tipos de cuenta. Exchange (EWS) queda fuera: es otra
  incidencia (#211), que puede reutilizar `receipts::delivery_receipt`.

## Decisión

- **Mover una carpeta en Graph** (`folders.move`, el mismo comando que IMAP):
  - solo en una cuenta cuyo permiso se guardó con cambios (`Mail.ReadWrite`,
    #141). Sin él, la guarda de solo lectura lo para antes de nada y la
    interfaz dice «Permite los cambios de esta cuenta en sus ajustes para
    mover sus carpetas». No hace falta ningún permiso nuevo;
  - las carpetas de Graph no son rutas sino ids opacos con su padre, así que
    las reglas de ADR-0050 se comprueban sobre el árbol que Graph informó
    (`graph_folders`): nunca una carpeta especial (Bandeja de entrada,
    Enviados, Borradores, Elementos eliminados, Correo no deseado, Archivo),
    ni una que tenga una dentro, ni una carpeta de búsqueda (ni hacia ella),
    ni dentro de sí misma o de una subcarpeta, ni adonde ya está, ni al lado
    de otra con el mismo nombre (sin distinguir mayúsculas, como Exchange).
    La interfaz aplica las mismas reglas recorriendo `parent_id`;
  - una sola petición, `POST /me/mailFolders/{id}/move` con
    `{"destinationId": …}` (la raíz del buzón para el nivel superior), con
    `Prefer: IdType="ImmutableId"`, sin redirecciones y sin repetirla nunca.
    La respuesta tiene que decir el padre pedido; si no, no es confirmación;
  - después, haya ido bien, mal o en duda, se vuelve a leer el árbol de
    carpetas: la caché dice dónde está la carpeta en el servidor, no dónde se
    intentó dejar;
  - **resultado incierto** (se perdió la respuesta): se dice «no se sabe si
    se movió; no se ha repetido», y como el árbol ya se leyó de nuevo, volver
    a pedirlo encuentra la carpeta en su sitio («ya está ahí») y no manda
    una segunda petición;
  - con ids inmutables la carpeta conserva su id, y por tanto su nombre
    local: no hay renombrados y los mensajes en caché se quedan. Si Graph
    devuelve otro id, se informa ese renombrado para que favoritas, colores
    y vistas lo sigan.
- **Pedir confirmación de entrega en Graph:**
  - Graph envía el MIME tal cual (`sendMail` en base64, #143), sin sobre
    donde poner la petición. `isDeliveryReceiptRequested` es una propiedad
    del mensaje, que solo se puede fijar sobre un borrador. Así que, cuando
    se pide, el envío va en tres pasos: borrador a partir del mismo MIME
    (`POST /me/messages`, `text/plain` en base64), `PATCH` con
    `{"isDeliveryReceiptRequested": true}` y `POST /me/messages/{id}/send`;
  - **la política** es la de ADR-0048, ahora en una función pequeña y
    compartida, `receipts::delivery_receipt(pedida, la_vía_la_lleva)`: se
    pide solo si la persona la quiere y la vía puede llevarla (SMTP con
    DSN; Graph con cambios además de envío). Si no, el mensaje sale igual,
    por `sendMail`, sin la petición, y el envío responde
    `delivery_receipt: "unsupported"` como hoy. Sin pedirla, nada cambia;
  - un fallo antes del último paso (borrador o marca) es «no enviado»
    (`NotSent`): nada salió, se borra el borrador y el intento queda como
    rechazado, nunca como incierto. Si el borrador no se pudo borrar, o su
    creación quedó sin respuesta, se dice que puede quedar una copia en
    Borradores;
  - el último paso es un envío como los demás (#143): 202 aceptado; sin
    respuesta o 5xx, incierto, sin deshacer ni repetir; un rechazo borra el
    borrador;
  - la copia de Enviados la guarda Microsoft, como con `sendMail`.
- **Leer los informes que llegan** (todos los tipos de cuenta):
  - el analizador MIME del núcleo reconoce un `multipart/report` de primer
    nivel con `report-type=delivery-status` (DSN, RFC 3464) o
    `disposition-notification` (MDN, RFC 8098), y lee solo su parte para
    máquinas (`message/delivery-status`, `message/disposition-notification`
    y sus variantes `global` de RFC 6533), nunca el texto para personas;
  - de cada destinatario: entregado, reenviado sin más informes (`relayed`,
    `expanded`), retrasado, fallido (con su código de estado RFC 3463 y las
    palabras del servidor, limitadas a 500 caracteres y sin caracteres de
    control), mostrado o tratado sin mostrar (`deleted`, `dispatched`,
    `processed`). Lo que no se reconoce (`denied`, `failed` de RFC 3798,
    acciones inventadas) no se interpreta: un informe mal formado se queda
    como un mensaje normal;
  - **vínculo:** por Message-ID. El MDN lo dice en `Original-Message-ID`; el
    DSN, en la copia o las cabeceras del original que devuelve
    (`message/rfc822`, `text/rfc822-headers`, `message/global[-headers]`).
    Se guarda por cuenta en `delivery_reports` (esquema 64) al guardar el
    cuerpo en caché, sea cual sea el protocolo que lo trajo. Una palabra
    final sustituye a un retraso y nunca al revés; si no, gana el informe
    más reciente. Un informe en Enviados o Borradores (una confirmación que
    envió esta cuenta) no cuenta como recibido;
  - **dónde se ve:** en el mensaje enviado con ese Message-ID, en la misma
    cuenta, una línea por destinatario («Entregado a…», «No entregado a…»
    con el motivo, «Retrasado…», «Mostrado a…»); y en el propio informe, lo
    que dice. Un informe que no casa con ningún mensaje enviado se queda
    como un mensaje normal. Nada se envía ni se contesta por leerlos;
  - en Graph, un mensaje sin adjuntos se lee de su JSON, que en un informe
    solo trae el texto para personas. Al leer un mensaje se pide también su
    clase (`$expand` de la propiedad extendida `String 0x001A`); si es
    `REPORT.*`, se lee su MIME. Basta `Mail.Read`.
- **Privacidad:** no cambia lo que sale del equipo. El borrador vive unos
  instantes en el propio buzón de Microsoft, que ya recibía el mensaje; leer
  la clase del mensaje y los informes no manda nada. `docs/privacy.html` no
  cambia.

## Alternativas descartadas

- **Enviar en JSON (`sendMail` con el objeto `message`) cuando se pide la
  confirmación:** perdería la firma y el cifrado, las imágenes en línea y
  todo lo que el MIME ya construye igual para SMTP, EWS y Graph.
- **Cabecera `Return-Receipt-To` en el MIME:** no es un estándar y no hay
  forma de saber si Exchange la respeta (ya descartada en ADR-0048).
- **Repetir automáticamente un movimiento o un envío inciertos:** puede
  duplicar; se lee el estado del servidor en su lugar.
- **Mover carpetas en Graph como en IMAP, renombrando rutas:** sus carpetas
  no son rutas; el id y el padre son la verdad.
- **Interpretar informes por el asunto o el texto («Undeliverable:…»):**
  depende del idioma y del servidor y se puede falsificar sin esfuerzo; solo
  se lee la parte para máquinas.
- **Pedir el MIME de todos los mensajes de Graph para encontrar informes:**
  una descarga por mensaje abierto; la clase del elemento basta para saber
  cuáles lo son.
- **Ocultar o archivar los informes vinculados:** la persona decide qué
  hace con su correo; el informe se queda donde llegó.

## Pendiente

- **Evidencia con Microsoft 365 real** (la ejecución N5 final): que
  `/mailFolders/{id}/move` conserva el id con `ImmutableId`; que un borrador
  creado desde MIME conserva Message-ID, `Bcc`, firma y cifrado al marcarlo
  y enviarlo; que el MIME de un `REPORT.IPM.Note.IPNRN` o `.NDR` llega como
  `multipart/report`.
- Exchange (EWS): mover carpetas y pedir confirmación de entrega (#211).
- Un informe recibido en otra cuenta que la que envió el mensaje no se
  vincula (aislamiento entre cuentas).
- Un informe es una afirmación de quien lo envía: se muestra como lo que
  dice, sin comprobar que el destinatario fuera uno de los del mensaje.
- La lectura de un solo mensaje por id de UID (`messages.read`, fuera de un
  hilo) no lleva todavía los informes, igual que `receipt_requested`.
- La versión de esquema 64 puede chocar con otras ramas abiertas a la vez;
  la que se fusione después renumera.
