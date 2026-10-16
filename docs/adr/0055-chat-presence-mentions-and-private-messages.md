# ADR-0055: Presencia, menciones, avisos y mensajes privados en el chat (XMPP)

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  #208: «la opción más prudente»); pendiente de revisión del propietario al
  final del plan.
- Fecha: 2026-10-15.
- Alcance: #208, hija de #111 (fila SET-21 del libro de paridad, «Chat →
  General» de eM Client 10.4). Completa lo que ADR-0036 y ADR-0044 dejaron
  pendiente: la presencia y el estado propios, la presencia de los contactos,
  las menciones en los grupos, las notificaciones del sistema y los mensajes
  privados dentro de un grupo. El borrador #198 se usó como referencia y se
  revisó punto por punto; las diferencias están en «Alternativas
  descartadas».

## Decisión

- **El estado propio, por cuenta:**
  - «Disponible», «Ausente», «Ocupado» (`dnd`) e «Invisible», y un texto de
    estado de hasta 200 caracteres (sin caracteres de control);
  - se guarda como una fila de ajustes (`chat_presence:<cuenta>`, JSON), sin
    tablas ni columnas nuevas; un campo inválido vuelve a su valor por omisión
    («Disponible», sin texto) sin tocar el otro. Al quitar la cuenta se borra;
  - se anuncia al conectar y cada vez que la persona lo cambia; la vista
    muestra siempre el guardado, también antes de conectar, y la sesión
    empieza desde él (nunca desde «Disponible» por omisión).
- **A quién llega:**
  - el estado se anuncia sin destinatario, así que el servidor solo lo da a
    los contactos a los que la persona permitió verlo (suscripción, RFC 6121);
  - a los grupos en los que está dentro llega solo la disponibilidad
    (ausente, ocupado), **nunca el texto**: en un grupo hay gente que la
    persona no eligió;
  - la persona no recibe nada nuevo de nadie: la presencia de los demás la
    manda su servidor.
- **Invisible, solo donde el servidor lo admite** (XEP-0186):
  - en cada conexión se pregunta al servidor de la cuenta qué admite
    (disco#info); si anuncia `urn:xmpp:invisible:0`, «Invisible» se puede
    elegir; si no, aparece desactivado con el motivo y el núcleo lo rechaza;
  - invisible, la persona sigue recibiendo mensajes en directo y sus
    contactos la ven desconectada. Los grupos en los que ya está la siguen
    viendo (entrar en un grupo es presencia dirigida); la vista lo dice;
  - sin conexión no se sabe qué admite: «Invisible» espera a conectar y la
    vista lo dice («Conéctate para comprobar si este servidor puede
    ocultarte»);
  - si un «Invisible» guardado se encuentra con un servidor que ya no lo
    admite, **no se anuncia nada** (la persona sigue oculta, como pidió): sus
    contactos la ven desconectada y los mensajes directos y las peticiones
    para ver su estado esperan en el servidor hasta que elija otro estado;
    al elegirlo se anuncia y se recupera lo que llegó al archivo. Nunca pasa
    sola a visible;
  - si ya estaba anunciada, pasar a no anunciada envía «no disponible» a
    todos, y el servidor la saca también de los grupos (RFC 6121 §4.6); por
    eso se vuelve a entrar en ellos enseguida: los grupos la siguen viendo,
    disponible, como dice la vista.
- **La presencia de los contactos:**
  - llega del servidor y se guarda solo en memoria, para la sesión: una
    sesión nueva empieza de cero. No va al almacén, porque al volver estaría
    vieja;
  - un contacto visto que se desconecta, o del que el servidor dice que está
    desconectado (lo dice de los que la persona puede ver), queda como
    «Desconectado» para la sesión, sin volver a ofrecer «Pedir ver su
    estado»;
  - como cualquiera puede mandar presencia, se guardan como mucho 1000
    contactos, 50 dispositivos por contacto y 200 peticiones; lo que pasa de
    ahí se descarta. Una presencia con la marca de grupo (`muc#user`) nunca
    es de un contacto;
  - de un contacto con varios dispositivos se muestra el de prioridad más
    alta y, a igualdad, el más disponible (charlando, disponible, ausente,
    ausente mucho tiempo, ocupado);
  - se muestra junto a cada conversación directa y en su cabecera, con su
    texto de estado.
- **Ver el estado de otro es decisión de la persona:**
  - «Pedir ver su estado» manda la petición (`subscribe`) solo al pulsar;
  - las peticiones de otros se muestran como propuesta, con «Permitir»
    (`subscribed`) y «Rechazar» (`unsubscribed`); nada se contesta solo y
    permitir no pide lo mismo de vuelta. «Permitir» solo contesta a quien lo
    pidió en esta sesión; «Rechazar» vale para cualquiera;
  - las peticiones pendientes se guardan solo en memoria: el servidor las
    vuelve a entregar en cada conexión.
- **Menciones en un grupo:**
  - un mensaje de otro menciona a la persona si su texto contiene su apodo en
    ese grupo como palabra entera (sin distinguir mayúsculas; letras, cifras
    y `_` de cualquier alfabeto forman palabra), o si lleva una referencia
    XEP-0372 a su dirección o a su sitio en el grupo (`grupo/apodo`). Un
    apodo de menos de tres caracteres solo menciona tras `@` («al», «Jo» son
    también palabras corrientes). Lo propio nunca menciona;
  - al escribir `@` y el principio de un apodo, el editor ofrece los que
    están en el grupo ahora (sin la persona), filtrados por ese principio, a
    lo sumo 8; flechas, Intro o Tab para elegir y Escape para cerrar. Lo
    elegido se escribe como `@apodo `;
  - los apodos elegidos salen además como referencias XEP-0372 (`begin` y
    `end` en caracteres), solo si siguen en el texto al enviar. Lo elegido no
    se guarda: «Enviar de nuevo» manda como referencias los apodos escritos
    con `@` de quienes están en el grupo en ese momento;
  - quién está en cada grupo sale de la presencia del grupo, en memoria; un
    apodo que el grupo nos cambia (estado 210) se guarda tal cual lo da el
    grupo, aunque no sea uno que aceptaríamos al unirse, para que las
    menciones y el eco sigan funcionando;
  - el resaltado se calcula al leer la historia con el apodo actual, sin
    columna nueva. Una mención hecha solo por referencia, sin el apodo en el
    texto, avisa al llegar pero no queda resaltada después.
- **Notificaciones del sistema:**
  - decide el núcleo, que sabe cómo llegó cada mensaje (función pura
    `should_notify`): solo un mensaje guardado por primera vez, de otra
    persona y llegado en directo, o como copia de uno recibido en otro
    dispositivo (carbons `received`: llega en directo y es nuevo aquí). Lo
    que llega al ponerse al día (archivo, historia del grupo, mensajes con
    retraso) no avisa: se ve como no leído;
  - mensajes directos y privados: siempre; en un grupo, solo las menciones;
  - nunca mientras el estado propio de esa cuenta es «Ocupado», y la vista
    lo dice bajo el selector;
  - el núcleo emite `chat.notify` (cuenta, conversación, tipo, grupo, quién
    y el texto, o el nombre del archivo, cortado a 280 caracteres; el título,
    a 120); el puente
    Go muestra la notificación salvo con «No molestar» o en horas tranquilas
    (ADR-0049): un mensaje de chat cuenta como un mensaje, igual que el
    correo, y no como un recordatorio;
  - el título es quien escribe y, en un grupo o en privado, `· grupo`, sin
    textos nuevos que traducir en Go; al pulsarla se abre esa conversación
    en la vista Chat;
  - lo que escribió otro se muestra como texto: en Linux el cuerpo se escapa
    para el servicio de notificaciones que lee marcas (`body-markup`) y, en
    Windows, título, cuerpo y destino se protegen para la plantilla XML de
    la notificación, que los inserta tal cual (esto último también arregla
    el correo, cuyo destino puede llevar `<` y `>` de un Message-ID).
- **Mensajes privados dentro de un grupo** (XEP-0045 §7.5):
  - son una conversación propia, `grupo@servicio/apodo` (tipo `private`),
    listada con las directas como «apodo (grupo)»; el apodo conserva sus
    mayúsculas;
  - se abren desde el apodo de quien habla en el grupo o desde la lista de
    quién está; salen como `chat` a `grupo/apodo`, con `origin-id`, la marca
    `muc#user` y sin pedir recibo (lo reparte el grupo);
  - solo se reconocen como privados los de un grupo en el que la persona
    está; uno del grupo sin apodo no es una conversación; un error devuelto
    para uno nuestro lo deja en «no enviado», como siempre;
  - al salir del grupo, sus privados **se quedan** para leerlos: el archivo
    del grupo no los guarda, así que borrarlos los perdería. Escribir en
    ellos otra vez necesita volver a estar en el grupo (sin él no hay apodo
    con el que escribir y el núcleo lo rechaza).

## Alternativas descartadas

- **Tablas y columnas nuevas (esquema 63/64, como en #198):** otras tareas
  añaden migraciones a la vez y los números chocarían; el estado cabe en una
  fila de ajustes y la mención se calcula al leer. Por eso una mención hecha
  solo por referencia avisa al llegar pero no queda resaltada después.
- **Borrar los privados al salir del grupo:** se perderían sin remedio, sin
  que la persona lo haya pedido.
- **Leer la lista de contactos del servidor (roster) para saber a quién se
  puede ver:** necesita contestar a sus avisos de cambios; recordar lo visto
  en la sesión, y lo que el servidor dice de los contactos desconectados,
  basta para no ofrecer pedirlo otra vez. Gestionar quién ve el estado queda
  pendiente.
- **Invisible enviando «no disponible» y consultando el archivo cada poco
  (#198):** la persona dejaría de recibir en directo y saldría de los
  grupos; XEP-0186 es la forma estándar y, sin ella, se dice que no se puede.
- **Ausente sola por inactividad (#198):** necesita saber la inactividad del
  sistema en cada plataforma desde Go; queda pendiente.
- **Modos de aviso por conversación (todo, menciones, silencio, #198):** no
  los pide #208; el silencio general ya lo dan «No molestar» y las horas
  tranquilas.
- **Mandar el texto de estado también a los grupos:** lo verían personas
  que la persona no eligió.
- **Decidir las notificaciones en la vista:** la vista no sabe si un
  mensaje llegó en directo o del archivo, y con la ventana en la bandeja sus
  temporizadores se retrasan (ADR-0049).
- **Avisar también de lo recuperado al conectar:** al abrir la aplicación
  tras días cerrada saldría una notificación por cada mensaje antiguo.
- **Pedir recibo de entrega en los privados:** el grupo los reparte y el
  recibo del otro revelaría cuándo lee a alguien que no está entre sus
  contactos.

## Pendiente (#111 sigue abierta)

- Ausente por inactividad y silenciar una conversación concreta.
- Gestionar quién puede ver el estado propio (retirar un permiso dado).
- Un contador de menciones sin leer.
- Probar «Invisible» contra un servidor con XEP-0186 (el Prosody de CI no lo
  trae) y la notificación nativa en Windows (N4).
- Rocket.Chat; Teams y Slack cuando existan los registros.
