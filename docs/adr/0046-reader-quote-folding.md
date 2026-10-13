# ADR-0046: Plegar el texto citado y ajustar los mensajes anchos en el lector

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: fila S01-07 del registro de paridad
  (`docs/emclient-parity-acceptance.json`), #35. eM Client 10.4 pliega en
  el lector el texto citado de las respuestas y puede ajustar al ancho de
  la ventana un mensaje maquetado más ancho que ella. Oreneta ya contenía
  el HTML de ancho fijo (con una barra horizontal propia) y tenía el
  tamaño de texto del mensaje (80–400 %); faltaban las dos cosas.

## Decisión

- **Qué se pliega (texto citado), activado por omisión:**
  - Gmail: el `div.gmail_quote` (o `gmail_quote_container`) más externo
    que contenga un `blockquote`, con su línea «On … wrote:»;
  - Outlook en la web / nuevo Outlook: desde `#appendonsend` y el `<hr>`
    que precede a `#divRplyFwdMsg` hasta el final de su contenedor;
  - Outlook de escritorio: el bloque con borde superior cuya primera línea
    es «From:» y que dice cuándo se envió («Sent:»/«Date:»/«Enviado:»…), o
    una línea «-----Original Message-----», hasta el final de su
    contenedor;
  - Apple Mail y Thunderbird: `blockquote type="cite"`, con la línea de
    atribución (`.moz-cite-prefix` o «… wrote:») que lo precede;
  - un `blockquote` sin `type=cite` solo si una línea de atribución lo
    precede;
  - texto plano: el bloque final de líneas que empiezan por «>», con su
    atribución (también partida en dos líneas); una sola línea «>» sin
    atribución no basta. También el bloque de cabecera de Outlook
    («______», «From:», «Sent:») y «-----Original Message-----».
  - Las citas anidadas quedan dentro de un solo pliegue: el más externo.
- **Qué no se pliega nunca:**
  - un reenvío: «Forwarded message», «Begin forwarded message», «Mensaje
    reenviado»… o un asunto «FW:/Fwd:/RV:/TR:/WG:/ENC:» en la cabecera; lo
    reenviado es el contenido;
  - una cita que no está al final (respuesta intercalada): si después hay
    algo que leer, además de una firma, se deja abierta, porque ocultarla
    escondería a qué se responde;
  - lo que solo parece una cita (un `blockquote` con una tabla, una cita
    literaria) sin marca de cliente ni atribución;
  - un mensaje que se quedaría vacío: si plegar dejara sin nada visible
    (una respuesta que es solo la cita, el primer mensaje de un hilo que
    solo trae la cita), no se pliega nada; si lo único visible fuera la
    firma, se pliega la cita y la firma queda a la vista.
- **Firmas, desactivado por omisión:** se pliegan solo las marcadas como
  tales por el programa del remitente (`.gmail_signature` con su prefijo
  «-- », `#Signature`, `.moz-signature`, `div[data-signature]`) y, en
  texto plano, el bloque tras «-- » de como mucho 12 líneas antes del
  final o de la cita. eM Client pliega las citas; plegar firmas es una
  opción aparte y conservadora.
- **Cómo se pliega:**
  - en el HTML, el tramo se envuelve en `<details>`/`<summary>` cerrado
    («Mostrar texto citado» / «Ocultar texto citado»). Abre y cierra el
    propio navegador, sin ningún script dentro del marco: la CSP del marco
    (`script-src 'none'`) no cambia, el marco no envía nada a la app y no
    se añade ninguna carga remota (el estilo va en línea en un `<style>`);
  - en texto plano, un botón de la app con `aria-expanded`;
  - es solo presentación: el cuerpo guardado, la cita de la respuesta y la
    impresión salen del mensaje, no del marco;
  - la búsqueda en el hilo abre el pliegue que contiene una coincidencia y
    no cuenta como coincidencia la etiqueta del botón.
- **Ajustar al ancho (desactivado por omisión):**
  - se mide hasta dónde llega el contenido que no puede encogerse (tablas,
    imágenes, bloques; no lo que ya se desplaza solo, como un bloque de
    código) y se reduce con el mismo `zoom` del cuerpo que usa el tamaño de
    texto, multiplicado por él: `zoom = tamaño de texto × ajuste`, de modo
    que el tamaño elegido sigue contando;
  - solo encoge, nunca por debajo del 40 % del tamaño elegido; si cambia el
    ancho del panel se vuelve a medir desde el tamaño natural;
  - se ajusta antes de la barra horizontal de rescate: una tabla ajustada
    no la necesita;
  - no afecta al texto plano, que siempre se ajusta solo;
  - por mensaje desde su menú («Ajustar a la ventana» / «Ver a tamaño
    original»), durante la sesión; sin elección, manda el ajuste.
- **Ajustes (Lectura):** «Plegar el texto citado» (`reader_fold_quotes`,
  sí), «Plegar las firmas» (`reader_fold_signatures`, no) y «Ajustar los
  mensajes anchos a la ventana» (`reader_fit_width`, no), cada uno una fila
  de preferencias, como el resto (`DB_KEY`).

## Alternativas descartadas

- **Un script dentro del marco para plegar y desplegar:** obligaría a
  relajar la CSP que bloquea todo script del correo. `<details>` lo hace
  sin script.
- **Plegar en el núcleo, al preparar el HTML:** el mismo HTML lo usan la
  respuesta y la impresión; plegar es cosa de cómo se lee, y la etiqueta
  depende del idioma de la interfaz.
- **Plegar toda cita, también intercalada o sin marca:** esconde
  respuestas escritas entre líneas y contenido citado a propósito. Mejor
  dejar abierto lo dudoso.
- **Ajustar con `transform: scale`:** no cambia la caja, así que el marco
  autoajustable mediría la altura sin escalar y dejaría un hueco; `zoom`
  sí la cambia y es lo que ya usa el tamaño de texto.
- **Ajustar siempre:** un boletín pensado a 600 px se lee mejor a su tamaño
  con la barra horizontal en un panel estrecho que reducido a la mitad; por
  eso es una opción, apagada por omisión.

## Pruebas

- `quoteFolding.test.ts`: corpus realista — respuesta de Gmail (con
  firma), reenvío de Gmail, Outlook en la web (respuesta y reenvío),
  Outlook de escritorio, Apple Mail (respuesta y reenvío), Thunderbird (con
  citas anidadas y firma), respuesta intercalada de Thunderbird, contenido
  que solo parece cita (tabla en `blockquote`, cita literaria), mensaje que
  es solo cita o solo firma; texto plano con «>», atribución partida,
  citas anidadas, firma «-- », cabecera de Outlook, «Original Message»,
  reenvíos, una línea «>» suelta y un «--» largo que no es firma.
- `ReaderFolds.test.tsx`: abrir y cerrar el pliegue del texto plano, firma
  según el ajuste, sin pliegues con el ajuste apagado, pliegue abierto por
  una búsqueda, `<details>` cerrado bajo la CSP del marco sin scripts,
  factor de ajuste (proporción, mínimo, nunca crece), elección por mensaje
  frente al ajuste, la acción del menú solo para HTML y las tres filas de
  Ajustes.
- `startup.e2e.ts` (CSP de producción): el pliegue del HTML se abre y
  cierra en el marco y el del texto plano en la app; con «Ajustar a la
  ventana», una tabla fija de 1200 px cabe en el panel sin barra
  horizontal, con el zoom del cuerpo por debajo de 1 y la tabla intacta.

## Pendiente

- Recordar entre sesiones la elección de ajuste por mensaje.
- Plegar texto citado en la vista previa móvil.
