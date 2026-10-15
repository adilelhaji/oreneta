# ADR-0060: Opciones de impresión

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #213); pendiente de revisión del propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #213, fila SET-05 del libro de paridad («General → Imprimir» de
  eM Client 10.4), sobre la impresión de #35. Las garantías de #35 no
  cambian: el contenido remoto sigue bloqueado y lo que queda fuera se dice.
  Diseño: [docs/design/printing.md](../design/printing.md).

## Decisión

- **Un grupo de Ajustes, no un diálogo al imprimir:** «Imprimir» en Ajustes →
  General, con el mismo patrón que «Respuestas y reenvíos» (ADR-0047).
  Imprimir sigue siendo un clic y la elección se recuerda sin pasos de más.
- **Una sola preferencia, una sola fila:** `settings$.print`, guardada en la
  fila `print_options` de `settings` como un objeto. Al leerla, cada campo
  desconocido o inválido vuelve a su valor por omisión por separado
  (`sanitizePrintOptions`).
- **Las opciones y sus valores por omisión** (los de antes, para que nadie vea
  cambiar su impresión porque apareció un ajuste):
  - campos de cabecera: asunto como título de la página, fecha, Para y CC
    activados; CCO desactivado;
  - alcance: la conversación entera (por omisión) o un mensaje;
  - orden, solo para la conversación: del más antiguo al más reciente (por
    omisión) o al revés;
  - lista de adjuntos por nombre: activada.
- **El remitente se imprime siempre:** en papel no hay otra forma de saber
  quién escribió cada mensaje. En Ajustes se muestra como «Siempre se
  imprime», no como un interruptor.
- **CCO apagado por omisión:** solo existe en las copias enviadas y nombra a
  personas de las que los demás destinatarios no sabían; va al papel solo si
  se pide.
- **Qué es «este mensaje»:**
  - desde el menú de un mensaje («Imprimir mensaje…», nuevo), ese mensaje,
    sea cual sea el alcance recordado; las demás opciones se aplican;
  - desde el menú de la conversación con el alcance «Un mensaje», el mensaje
    más reciente de los cargados, que es el que la conversación muestra
    primero y el que representa en la lista;
  - un mensaje se imprime con su propio asunto (puede ser el de una
    respuesta).
- **Orden por fecha, no por orden de carga,** con orden estable: dos mensajes
  del mismo segundo conservan el orden en que llegaron.
- **El título de la página (`<title>`) se mantiene** aunque se quite el
  asunto: es el nombre del PDF o del trabajo de impresión.
- **Lo que queda fuera se dice** (#35), arriba, antes del primer mensaje:
  - conversación: el aviso de mensajes antiguos no cargados, como antes;
  - un mensaje: «Solo se imprime este mensaje de la conversación…» cuando la
    conversación tiene otros, cargados o aún en el servidor;
  - no se avisa de lo que la persona eligió quitar (cabeceras, adjuntos).
- **Contenido remoto:** la política CSP propia de la página, la retirada de
  píxeles de seguimiento y el marco sin scripts no dependen de ninguna
  opción; las pruebas lo comprueban con todas las combinaciones.

## Alternativas descartadas

- **Diálogo de opciones en cada impresión:** un paso más cada vez para una
  elección que casi nunca cambia, y un patrón de diálogo nuevo; el diálogo
  del sistema ya permite elegir páginas e impresora.
- **Una fila por opción:** ocho filas nuevas en `settings` para un grupo que
  se lee siempre junto.
- **Remitente como opción:** una impresión sin remitente no dice quién
  escribió qué.
- **«Este mensaje» desde la cabecera como el mensaje visible o enfocado:** el
  lector no tiene hoy un mensaje seleccionado; inventarlo cambiaría la vista
  de conversación, fuera de este alcance.
- **Avisar también de las cabeceras o adjuntos quitados:** es una elección de
  quien imprime, no una omisión oculta.

## Pendiente

- Prueba nativa de impresión en Windows (ejecución N4 final): SET-05 no pasa
  a «verified» sin ella.
- Vista previa de impresión propia y opciones de página (márgenes, fondo).
