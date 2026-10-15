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
    La respuesta tiene que decir el padre pedido. Un éxito de otra forma
    (otro padre, ninguno, una respuesta ilegible) o un 5xx no es ni
    confirmación ni rechazo: es **incierto**. Solo un rechazo del servidor
    (4xx) se dice «no se movió»;
  - después, haya ido bien, mal o en duda, se vuelve a leer el árbol de
    carpetas: la caché dice dónde está la carpeta en el servidor, no dónde se
    intentó dejar;
  - **resultado incierto**: se dice «no se sabe si se movió; no se ha
    repetido». El árbol ya se leyó de nuevo en el núcleo y la interfaz
    vuelve a pedir la lista, así que volver a pedirlo encuentra la carpeta en
    su sitio: «ya está ahí», dicho como información y no como error, sin
    segunda petición;
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
    DSN; Graph con cambios además de envío). Sin pedirla, nada cambia;
  - **prudencia hasta tener evidencia de Microsoft 365:** no se sabe todavía
    si un borrador hecho desde MIME conserva los destinatarios Cco ni la
    firma o el cifrado byte a byte. Perder un Cco sería silencioso. Así que
    el borrador solo se usa para un mensaje sin Cco y sin firma ni cifrado.
    En los demás casos (o sin cambios permitidos) el mensaje sale como
    siempre por `sendMail`, sin la petición, y el envío responde
    `delivery_receipt: "unsupported"` con `delivery_receipt_reason`
    (`needsChanges`, `bcc` o `protected`), que el redactor explica;
  - un fallo antes del último paso (borrador o marca) es «no enviado»
    (`NotSent`): nada salió, se borra el borrador y el intento queda como
    rechazado, nunca como incierto. Si el borrador no se pudo borrar, o su
    creación quedó sin respuesta, se dice que puede quedar una copia en
    Borradores;
  - el último paso es un envío como los demás (#143, contrato de #29): 202
    aceptado; sin respuesta, 5xx, cualquier otro 2xx o una respuesta
    ilegible, **incierto**, sin deshacer ni repetir, diciendo que puede
    quedar una copia en Borradores; solo un rechazo (4xx) borra el borrador
    y deja el intento como rechazado. `sendMail` sigue la misma regla;
  - el borrador puede verse en Borradores desde otros clientes durante el
    instante que tarda el envío. Si la aplicación se cierra entre crear el
    borrador y enviarlo, el borrador queda allí y el intento queda abierto
    en `outgoing_attempts` (#29), que la persona resuelve;
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
    cuerpo en caché, sea cual sea el protocolo que lo trajo, **solo si la
    cuenta tiene ese mensaje** (en su caché o en `outgoing_attempts`); si
    no, no se guarda nada y el informe se queda como un mensaje normal, así
    que la tabla no crece con lo que no vincula nada. Una palabra final
    sustituye a un retraso y nunca al revés; si no, gana el informe más
    reciente, con su fecha acotada por el momento en que se lee (una fecha
    futura no puede ganar). Un informe en Enviados o Borradores (una
    confirmación que envió esta cuenta) no cuenta como recibido;
  - **cuándo se vincula:** cuando se lee el cuerpo del informe. En Graph,
    al sincronizar una carpeta se piden (una consulta, por clase de
    elemento) hasta 20 informes aún no leídos y se lee su MIME, también los
    guardados antes de esta versión; cada uno se lee una sola vez. En IMAP y
    EWS depende de que el cuerpo se descargue (precarga o al abrirlo); un
    informe guardado en caché antes de esta versión no se vuelve a leer;
  - **dónde se ve, y cómo:** un informe es una afirmación de quien lo
    envía, y se dice así: «El informe dice que se entregó a…», «El programa
    de correo de … dice que se mostró», con su fecha, «a fecha de …» para un
    retraso, los fallos primero, y marcado cuando nombra a alguien a quien
    el mensaje no iba dirigido. El motivo de un fallo se da con una frase
    para los códigos RFC 3463 comunes (x.1.1/x.1.10 la dirección no existe,
    x.2.2 buzón lleno, x.7.x rechazado por la política del servidor, 4.x.x
    problema temporal) y las palabras del servidor aparte, sin repetir el
    código; direcciones y motivos van aislados (bidi) y sin caracteres de
    formato (Cf), para que un texto de derecha a izquierda no reordene la
    frase. En el propio informe se ve lo que dice, con el título «Informe de
    entrega» o «Informe de lectura», y «sobre un mensaje que enviaste» solo
    si casa con uno de esta cuenta. Nada se envía ni se contesta por
    leerlos;
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
  si otra rama se fusiona antes, esta renumera su migración.
- Un informe que llega antes de que la cuenta tenga en caché el mensaje
  enviado (y que no se envió desde esta aplicación) no se guarda y no se
  vuelve a intentar.
- Confirmación de entrega en Graph para mensajes con Cco o firmados o
  cifrados, cuando la evidencia N5 muestre que el borrador los conserva
  (comprobando también los destinatarios del borrador antes de enviarlo).
