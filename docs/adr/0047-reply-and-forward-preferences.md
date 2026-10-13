# ADR-0047: Preferencias de respuesta y reenvío

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-09 de la paridad con eM Client 10.4 (#39), «Correo →
  Respuestas y reenvíos». Los destinatarios de responder y responder a
  todos y la identidad (alias) ya estaban resueltos y probados; faltaban el
  formato de la cita, el encabezado de la respuesta y el modo de reenvío.
  La documentación de eM Client no era accesible desde el entorno de
  trabajo, así que se sigue el conjunto común de los clientes de escritorio
  (eM Client, Outlook, Thunderbird).

## Decisión

- **Una sola preferencia, una sola fila:** `settings$.replyForward`, que se
  guarda en la fila `reply_forward` de `settings` como un objeto. Al leerla,
  cada campo desconocido o inválido vuelve a su valor por omisión por
  separado (`sanitizeReplyForwardPrefs`), así que una fila escrita por una
  versión más nueva no hace perder las demás elecciones.
- **Las opciones y sus valores por omisión:**
  - incluir el mensaje original en las respuestas: sí;
  - dónde se escribe la respuesta: encima de la cita (por omisión) o debajo
    (respuesta al pie);
  - cómo se cita: bloque HTML (`blockquote` con borde izquierdo, el que ya
    pone `inlineRichStyles` al enviar) o texto plano con «> » delante de
    cada línea; una línea que ya empieza por «>» recibe otro «>» y los
    niveles se apilan como «>> »;
  - encabezado: corto («El {fecha}, {nombre} escribió:») o el bloque de
    Outlook (De / Enviado / Para / CC / Asunto, sin las filas vacías);
  - acortar los prefijos repetidos del asunto: sí («Re: RE: Aw: Re[2]:»
    pasa a «Re:»; «Fwd: FW:» a «Fwd:»; un «Re:» dentro de un reenvío se
    conserva); apagado, se mantiene el comportamiento anterior (se añade
    «Re: » salvo que el asunto ya empiece por «Re:»);
  - reenviar: en línea (por omisión) o como adjunto `.eml`;
  - en un reenvío en línea, copiar los adjuntos del original: sí (lo que ya
    hacía la app).
- **Dónde se aplica la cita:** en la respuesta abierta en el editor
  completo (`openReplyInFullEditor`). La respuesta rápida del hilo es una
  conversación: el original ya está en pantalla encima, así que no se cita,
  pero sí usa el asunto acortado. Si la preferencia deja fuera el original,
  la respuesta se abre exactamente como antes.
- **HTML o texto:** un original HTML se responde en HTML; si no, una
  respuesta sin nada escrito sigue el formato de la cuenta, como un mensaje
  nuevo, y el texto traído de la respuesta rápida conserva su forma plana.
  Con la cita en texto plano la respuesta es siempre de texto plano.
- **La firma va con lo que escribe la persona, no después de la cita:**
  - respuesta encima de la cita y sin nada escrito: se siembra como un
    reenvío (cita en el cuerpo, firma con la marca `aboveQuote`), para que
    cambiar de cuenta cambie la firma en su sitio y no añada otra bajo la
    cita;
  - en los demás casos `openComposeTab` coloca la firma tras el texto propio
    y después une la cita delante o detrás (`joinReplyBody`).
- **Fechas, nombres y escapes:**
  - la fecha se escribe con `Intl.DateTimeFormat` en el idioma de la app
    (`dateStyle: medium`, `timeStyle: short`) y la zona del sistema; las
    pruebas fijan la zona;
  - las frases y etiquetas pasan por `t()` con `defaultValue`;
  - nombres, direcciones y asuntos se escapan en HTML;
  - un valor con escritura de derecha a izquierda se aísla con FSI…PDI
    (U+2068/U+2069) para que la frase no se desordene; los demás valores no
    llevan marcas invisibles.
- **Reenviar como adjunto:**
  - el puente Go añade `mail.rawMessage`, que reutiliza `messages.saveRaw`
    del núcleo (el mismo camino que «Guardar como .eml») hacia un archivo
    temporal privado, lo lee, lo borra y devuelve los bytes en base64 con un
    nombre de archivo saneado; los bytes no cruzan el protocolo JSON
    acotado del núcleo;
  - límite de 50 MB: un original mayor no pasaría los límites de los
    proveedores una vez codificado;
  - el borrador se abre con el asunto «Fwd:» y el cuerpo vacío (con firma),
    y el original se añade como `message/rfc822`;
  - si no se puede traer (sin conexión, sin motor), el borrador sigue
    abierto y un aviso de error lo dice; nunca se envía sin el original en
    silencio;
  - un mensaje que solo existe aquí (un envío optimista que aún no volvió
    del servidor) no tiene original que adjuntar y se reenvía en línea;
  - al construir el MIME (`smtp::build_message`), un adjunto
    `message/rfc822` limpio en 7 bits se escribe tal cual con
    `Content-Transfer-Encoding: 7bit`, como pide RFC 2046 §5.2.1; uno que no
    lo es (8 bits, líneas de más de 998 caracteres, saltos sueltos) sigue en
    base64, porque la app envía solo en 7 bits y los lectores abren ambos.

## Alternativas descartadas

- **Una fila por opción:** siete filas nuevas en `settings` y siete ramas de
  hidratación para un grupo que se lee siempre junto.
- **Citar también en la respuesta rápida:** el hilo ya muestra el original y
  cada burbuja enviada lo repetiría; además la burbuja optimista y el
  borrador compartido tendrían que distinguir el texto propio del citado.
- **Traer el original al navegador por el protocolo del núcleo:** sus
  respuestas tienen tamaño de línea acotado; escribir a un archivo temporal
  ya existe y no lo tiene.
- **Base64 para todo `message/rfc822`:** funciona en la práctica, pero RFC
  2046 lo prohíbe y algunos lectores estrictos no abren el adjunto como
  mensaje.

## Pendiente

- Prueba nativa (Windows) y de proveedor del reenvío como adjunto: SET-09
  sigue «partial» hasta que la issue propietaria enumere la evidencia.
- Reenviar varios mensajes a la vez como adjuntos.
- Responder con la selección citada (solo el texto marcado).
- Plantillas de encabezado editables por la persona.
