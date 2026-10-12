# Redacción sin errores silenciosos (#39)

Parte de #39 entregada en la iteración 2. La recuperación completa de
borradores (#170) tiene su propio contrato en
[editor-draft-recovery.md](editor-draft-recovery.md).

## Fallos reproducidos

- **Nombres con coma.** El editor ya leía bien `"Doe, John" <j@x.com>`, pero
  tres caminos no:
  - la lista de direcciones de las respuestas (`splitAddressList`) se partía
    por cada coma. Responder a todos con la propia dirección entrecomillada en
    Cc dejaba un fragmento `"Me` como destinatario;
  - responder a un remitente llamado `Doe, John` escribía
    `Doe, John <j@x.com>` sin comillas, y el propio editor lo leía como dos
    entradas, una de ellas inválida;
  - aceptar del desplegable un contacto llamado `Doe, John` producía las
    mismas dos entradas.
- **Diálogo «sin asunto» fijo en inglés.**

## Contrato

- **Lista de direcciones.** Se divide con el mismo analizador del editor: comas
  y puntos y coma separan, salvo dentro de comillas o de `<…>`.
- **Nombres al escribir una dirección.** Un nombre con `, ; < > "` se
  entrecomilla y se escapa al construir la respuesta y al aceptar un contacto.
- **Duplicados.** Un destinatario repetido no se añade dos veces en el campo. El
  núcleo ya deduplica el sobre SMTP.
- **Identidad.** El núcleo solo envía desde la dirección de la cuenta, su
  usuario de inicio de sesión o un alias guardado
  (`store::resolve_send_from`), y rechaza cualquier otra con un error que la
  nombra. El selector «De» muestra la cuenta o el alias elegido. No cambia en
  esta entrega.
- **Aviso de adjunto olvidado.** El aviso salta si el asunto o el texto propio
  del mensaje mencionan un adjunto y no hay ningún fichero adjunto. Las
  imágenes insertadas en el cuerpo no cuentan como ese adjunto. Antes de
  enviar se pregunta una vez; «Volver» deja el borrador intacto y «Enviar de
  todos modos» envía. Nunca bloquea solo por una palabra.
  - **Dónde.** Funciona en el editor completo y en la respuesta rápida.
  - **Palabras.** Son raíces guardadas en cada catálogo de idioma
    (`composer.attachmentReminder.keywords`), siempre junto con las inglesas.
  - **Cómo se busca.** En alfabetos con espacios, la raíz debe empezar palabra:
    «reattached» no cuenta. En chino, japonés, coreano y árabe se busca en
    cualquier posición.
  - **Citas.** No cuenta el texto citado: líneas `>` y `<blockquote>`.

## Pruebas

- `lib/address.test.ts` y `states/replyRecipients.test.ts` cubren la división
  con comillas y punto y coma. También la respuesta, la respuesta a todos con
  la propia dirección entrecomillada, `Reply-To` con nombre entrecomillado, el
  alias detrás de un nombre entrecomillado y el contacto del desplegable. Los
  casos de respuesta, respuesta a todos y contacto fallaban antes del cambio.
- `lib/attachmentReminder.test.ts` cubre cuerpo y asunto, adjunto presente,
  imagen insertada, citas en texto y HTML, límites de palabra, idioma más
  inglés, alfabetos sin espacios, árabe con artículo y mayúsculas con acentos.
- `Composer.test.tsx` comprueba aviso, «Volver» sin envío y «Enviar de todos
  modos» con envío, y que no hay aviso con adjunto. `compose.test.ts` comprueba
  lo mismo en la respuesta rápida.

## Límites

- Las listas de palabras son raíces sencillas. Una mención con otra forma
  («PJ», jerga) no avisa, y una palabra homónima, como «Anlage» en alemán,
  puede avisar de más. Por eso es un aviso y no un bloqueo.
- No hay ajuste para desactivar el aviso.
- No se validó con cuentas reales ni en el binario nativo.
