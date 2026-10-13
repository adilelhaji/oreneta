# ADR-0048: Confirmaciones de lectura y de entrega

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-11 de la paridad con eM Client 10.4 (#107), «Correo →
  Privacidad / Confirmaciones». El bloqueo de contenido remoto y la
  protección contra rastreadores (ADR-0029) ya existían; faltaba qué hacer
  con las confirmaciones: pedirlas al enviar y contestar a las que piden
  los mensajes recibidos.

## Decisión

- **Pedir confirmaciones al enviar:**
  - el redactor tiene dos interruptores, «Pedir confirmación de lectura» y
    «Pedir confirmación de entrega», que empiezan con lo elegido en
    Ajustes → Confirmaciones (ambos apagados por omisión; ajuste global,
    no por cuenta);
  - la de lectura es la cabecera `Disposition-Notification-To` con la
    dirección del remitente (RFC 8098 §2.1). Se escribe sobre el mensaje ya
    construido y antes de firmar o cifrar, así que una firma la cubre; la
    copia de Enviados también la lleva. Va igual por SMTP que por Exchange
    (EWS) y Microsoft Graph, que leen la cabecera del MIME que se les
    entrega;
  - la de entrega se pide al servidor por SMTP (DSN, RFC 3461):
    `RET=HDRS` en `MAIL FROM` y `NOTIFY=SUCCESS,FAILURE` con
    `ORCPT=rfc822;<dirección>` en cada `RCPT TO`. Solo si el servidor
    anuncia `DSN` en su respuesta a `EHLO` (que se repite antes de
    autenticar, porque la biblioteca no conserva esa extensión). Si no la
    anuncia, el mensaje sale igual, sin la petición, y el envío responde
    `delivery_receipt: "unsupported"`; el redactor lo dice al confirmar el
    envío. Sin pedirla, en la conexión no cambia nada;
  - un envío programado guarda las dos peticiones con el resto del
    mensaje.
- **Contestar a las que piden los mensajes recibidos:**
  - al leer un mensaje, el núcleo extrae la petición
    (`Disposition-Notification-To`, `Return-Path`, si viene de una lista
    —`List-Id`, `List-Post`, `List-Unsubscribe` o `Precedence`
    bulk/list/junk— y `Original-Recipient`) y la guarda con el mensaje en
    caché. Un informe (`multipart/report`) no se contesta nunca. La vista
    solo recibe `receipt_requested`;
  - la política se elige en Ajustes: «Preguntar cada vez» (por omisión),
    «Enviar siempre» o «No enviar nunca». Se guarda en el ajuste
    `read_receipt_policy`, que lee el núcleo; un valor desconocido cuenta
    como «preguntar»;
  - la decisión es una función pura (`receipts::decide`), en este orden:
    sin petición, nada; ya contestado, nada más; sin Message-ID, silencio
    (no se podría recordar ni nombrar); en Correo no deseado, silencio
    siempre (contestar confirmaría que la dirección funciona); «nunca»,
    silencio; si viene de una lista, o la confirmación iría a un dominio
    distinto del de `Return-Path` (o no hay `Return-Path`), se pregunta
    aunque la política sea «siempre» (RFC 8098 §2.1); si no, «siempre»
    envía sin preguntar y «preguntar» pregunta;
  - preguntar es una barra que no bloquea, encima del cuerpo: «El remitente
    pidió que le avisaras cuando leyeras esto. Enviar confirmación / No
    enviar», con el motivo de precaución cuando lo hay. No contestar no
    envía nada;
  - la respuesta, sea cual sea, se recuerda por cuenta y Message-ID
    (`receipt_answers`, esquema 59) y no se vuelve a preguntar. Se borra
    con la cuenta;
  - antes de enviar se reclama la fila (`INSERT OR IGNORE`), así dos
    lecturas del mismo mensaje no mandan dos confirmaciones. Si el servidor
    rechaza el envío, la fila se suelta y se puede volver a preguntar; si
    el resultado es dudoso (se entregó y no hubo respuesta), se queda como
    enviada, para no mandar una segunda.
- **La confirmación que se envía** se construye en el núcleo
  (`receipts::build_mdn`): `multipart/report;
  report-type=disposition-notification` con una parte de texto para la
  persona y la parte `message/disposition-notification` (en 7bit, nunca
  quoted-printable ni base64) con `Reporting-UA: Oreneta` (sin versión ni
  nombre de equipo), `Original-Recipient` si el mensaje lo traía,
  `Final-Recipient: rfc822;<dirección propia>`, `Original-Message-ID` y
  `Disposition: manual-action/MDN-sent-manually; displayed` o
  `automatic-action/MDN-sent-automatically; displayed`. Asunto
  «Read: …», `In-Reply-To` y `References` al original; la automática
  lleva además `Auto-Submitted: auto-replied` (RFC 3834). Los campos
  largos se pliegan en espacios; nombres y asuntos no ASCII van como
  palabras codificadas. Si alguna dirección no es ASCII se usa
  `message/global-disposition-notification` en 8bit (RFC 6533).
- **Se envía por la cuenta que recibió el mensaje**, desde la dirección
  propia a la que iba dirigido (o la principal), por su servidor SMTP o
  por Exchange/Graph, a las direcciones de la petición. No se guarda
  copia en Enviados, como la respuesta de fuera de la oficina.
- **Nada sale sin la persona:** solo su clic o su elección explícita de
  «siempre». Es la misma idea que la protección contra rastreadores: una
  confirmación dice que abriste el mensaje y cuándo, que es justo lo que
  un píxel de seguimiento intenta averiguar. La página de privacidad lo
  dice en su fila.

## Alternativas descartadas

- **`MAIL FROM:<>` (remitente nulo) para la confirmación,** como sugiere
  RFC 8098 §3: muchos servidores de envío autenticado lo rechazan o lo
  reescriben. Se usa la dirección de la cuenta; `Auto-Submitted` evita los
  bucles en la automática.
- **Preguntar también en Correo no deseado:** contestar a correo basura
  confirma la dirección; si el mensaje sale de ahí, se pregunta entonces.
- **Volver a pedir el mensaje entero al servidor para leer las cabeceras
  cada vez que se abre:** sería una descarga por mensaje abierto. La
  petición se extrae al analizar el cuerpo y se guarda con él.
- **Pedir confirmación de entrega a Exchange o Graph por cabeceras MIME
  (`Return-Receipt-To`):** no es un estándar y no hay forma de saber si se
  respeta; se dice que no está disponible en vez de prometerlo.

## Pendiente

- **Confirmación de entrega en EWS y Graph:** los dos envían MIME
  (`CreateItem` con `MimeContent` y `SendAndSaveCopy`; `sendMail` con el
  MIME en base64), sin sobre donde poner la petición. Graph tiene
  `isDeliveryReceiptRequested` y EWS `IsDeliveryReceiptRequested`, pero
  solo en el envío como objeto JSON/XML, que este código no usa. Hoy se
  responde «unsupported».
- **Mensajes en caché de antes de esta versión:** no tienen la petición
  guardada y no muestran la barra hasta que se vuelven a descargar. No se
  invalida la caché entera por esto.
- **Mensajes de Graph leídos sin MIME:** si la lectura no pasa por el
  analizador MIME, no se ve la petición (`isReadReceiptRequested` del
  recurso no se lee todavía).
- **Interpretar las confirmaciones y avisos de entrega recibidos** (mostrar
  «leído por…» en el mensaje enviado): fuera de esta fila.
- **Prueba con servidor real:** el maddy 0.8 de la integración no anuncia
  DSN, así que la prueba comprueba que la de entrega se informa como no
  disponible y que la de lectura llega de bob a alice tras su clic. Un
  servidor con DSN (Postfix) cubriría el camino `requested`.
- Un ajuste por cuenta en lugar de global, si alguien lo pide.
