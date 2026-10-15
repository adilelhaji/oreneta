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
- **CCO encendido se recuerda, y se avisa:** como las demás opciones, queda
  encendido hasta que se apague. Riesgo aceptado: quien lo deja encendido y
  luego imprime una conversación para otra persona le revela los
  destinatarios ocultos. La ayuda del ajuste lo dice («sigue activado hasta
  que lo desactives»). Se prefiere a apagarlo solo tras cada impresión porque
  la issue pide que las elecciones se recuerden y un ajuste que cambia por su
  cuenta sorprende; el valor por omisión sigue siendo apagado.
- **Qué es «este mensaje»:**
  - desde el menú de un mensaje («Imprimir mensaje…», nuevo), ese mensaje,
    sea cual sea el alcance recordado; las demás opciones se aplican;
  - desde el menú de la conversación con el alcance «Un mensaje», el mensaje
    más reciente de los cargados que no sea un borrador (carpeta de
    borradores) ni una copia local sin enviar (en la ventana de deshacer o
    pendiente de reintento). Es el mensaje al que el lector lleva la vista
    (el más antiguo queda arriba) y el que la vista tradicional abre
    desplegado. Si todos los cargados son borradores o copias sin
    enviar, se imprime el más reciente de ellos, marcado;
  - un borrador o una copia sin enviar que se imprime (en la conversación
    entera o pedido con «Imprimir mensaje…») lleva en el papel la marca
    «Borrador» o «No enviado», traducida: el papel no puede hacerlos pasar
    por correo que salió;
  - un mensaje se imprime con su propio asunto (puede ser el de una
    respuesta).
- **Orden por fecha, no por orden de carga,** con orden estable: dos mensajes
  del mismo segundo conservan el orden en que llegaron. «Más reciente
  primero» es exactamente ese orden al revés, empates incluidos.
- **El título de la página (`<title>`) se mantiene** aunque se quite el
  asunto: es el título de la ventana y el nombre del PDF o del trabajo de
  impresión. La ayuda del ajuste del asunto lo dice.
- **Lo que queda fuera se dice** (#35), arriba, antes del primer mensaje:
  - conversación: el aviso de mensajes antiguos no cargados, como antes;
  - un mensaje: «Solo se imprime este mensaje de la conversación…» cuando la
    conversación tiene otros, cargados o aún en el servidor;
  - un mensaje cuya conversación no está cargada aquí: no se sabe si tiene
    otros, así que se dice sin afirmarlo: «Solo se imprime este mensaje; los
    demás mensajes de la conversación, si los hay, no.»; una conversación
    cargada y completa de un solo mensaje no lleva aviso;
  - no se avisa de lo que la persona eligió quitar (cabeceras, adjuntos).
- **Sin conversación cargada no se imprime nada:** antes de que termine la
  carga, o si falla, no hay mensajes; una página vacía pasaría por una
  impresión. Se avisa con un mensaje de error («Esta conversación aún no se
  ha cargado…») y no se abre el diálogo de impresión. La página nunca afirma
  «solo se imprime este mensaje» si no imprime ninguno.
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
- **«Este mensaje» como el más reciente recibido, sin borradores ni envíos
  propios:** en una conversación cuya última palabra es una respuesta propia
  imprimiría un mensaje anterior a lo que se ve desplegado; se excluyen solo
  los borradores y las copias sin enviar, que no son correo que salió.
- **Apagar CCO tras cada impresión:** más prudente frente a la revelación,
  pero contradice que las elecciones se recuerden y cambia un ajuste sin que
  la persona lo toque; se acepta el riesgo con el aviso en la ayuda.
- **Avisar también de las cabeceras o adjuntos quitados:** es una elección de
  quien imprime, no una omisión oculta.

## Pendiente

- Prueba nativa de impresión en Windows (ejecución N4 final): SET-05 no pasa
  a «verified» sin ella.
- Vista previa de impresión propia y opciones de página (márgenes, fondo).
