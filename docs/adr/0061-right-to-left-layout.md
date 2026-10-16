# ADR-0061: Diseño de derecha a izquierda para el árabe

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #226 en la opción más prudente); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-16.
- Alcance: #226, hija de #37 (fila SET-27 del libro de paridad, «General →
  Idioma» de eM Client 10.4). El borrador #198 se usó solo como referencia de
  qué componentes tocar; no se fusiona. Fuera de alcance: la prueba nativa de
  métodos de entrada (ejecución N4) y otros idiomas de derecha a izquierda que
  no están en el catálogo. Diseño: [docs/design/right-to-left.md](../design/right-to-left.md).

## Decisión

- **Qué decide la dirección:** el idioma de la interfaz. `applyDocumentLanguage`
  pone `lang` y `dir` en `<html>` (`dir="rtl"` para el árabe) al arrancar,
  desde la caché de la última sesión, y cada vez que cambia el idioma; volver
  a un idioma de izquierda a derecha restaura `dir="ltr"` sin recargar. La
  lista de idiomas de derecha a izquierda es fija en `lib/direction.ts`, no
  una consulta a `Intl.Locale`: WebKitGTK y Bun no exponen todos esa
  información y la misma respuesta en todas partes vale más.
- **Propiedades lógicas, no lados:** márgenes, rellenos, posiciones, bordes,
  esquinas y alineación usan las utilidades lógicas de Tailwind 4.3
  (`ms/me`, `ps/pe`, `start/end`, `border-s/e`, `rounded-s/e/ss/se/es/ee`,
  `text-start/end`) y las propiedades lógicas de CSS
  (`margin-inline-start`, `inset-inline-end`, `float: inline-start`…). No
  hace falta ninguna dependencia nueva. Donde no hay forma lógica (una
  sombra interior, un desplazamiento con `translate-x`), la regla de
  derecha a izquierda va al lado con la variante `rtl:` o con
  `[dir='rtl']`.
- **Un guardián en las pruebas:** `lib/physicalDirection.ts` busca clases y
  estilos con lado físico en todos los componentes y en `App.tsx`; la prueba
  falla con cada uno nuevo. Lee los valores arbitrarios enteros
  (`ml-(--gap)`, `pl-[clamp(1px,2px,3px)]`) y salta los comentarios, también
  los de JSX. Se aceptan sin entrada en la lista: una clase emparejada en la
  misma línea con su contraparte `rtl:`/`ltr:`, y el centrado
  `left-1/2 -translate-x-1/2`, que cae en el mismo sitio en las dos
  direcciones. La lista de excepciones, cada una con su motivo:
  - las asas de las esquinas de una imagen en el redactor: sus nombres dicen
    «arriba a la izquierda» y el arrastre se calcula en píxeles de pantalla;
  - el estilo en línea de la cita del correo que sale, una regla por
    dirección: los clientes de correo (Outlook entre ellos) no admiten
    propiedades lógicas.

  No mira (se revisan a mano): las coordenadas y transformaciones en objetos
  `style` (`left`, `right`, `float`, `translateX`: las posiciones tomadas del
  puntero o de un rectángulo son físicas por naturaleza), ni `src/lib` ni
  `index.css`.
- **Iconos:** se reflejan los que apuntan a lo largo de la línea (flechas de
  atrás y adelante, chevrones, responder, reenviar, deshacer, enviar, la cita
  de una respuesta, los paneles laterales, las listas y el ajuste de línea).
  No se reflejan los de medios, las marcas, las flechas de orden (arriba y
  abajo) ni los logotipos. Un chevrón girado con `rotate-*` ya apunta en
  vertical y no se refleja; `no-mirror` excluye un icono. Un chevrón de
  desplegar que gira al abrirse se gira 180° en vez de reflejarse, para que
  la animación sea un cuarto de vuelta y no un parpadeo. Una sola regla en
  `index.css` por nombre de clase de Lucide, no un cambio en cada uso. Las
  flechas escritas como texto («→», «←») salen de `forwardArrow` y
  `backArrow`, que las invierten en derecha a izquierda.
- **Teclado en el sentido de lectura:**
  - en los separadores de paneles (ya lo hacía `PaneResizer`, ADR-0059), en
    las pestañas (proveedores de cuenta, listas de tareas) y en los grupos de
    opción (tipo de calendario, color de categoría), las flechas laterales
    siguen la lectura: en árabe la flecha izquierda va al siguiente. Inicio y
    Fin van a los extremos; las pestañas y los grupos se recorren en círculo.
    Si el foco aún no estaba en ningún elemento, la flecha solo lo lleva al
    primero, sin elegirlo;
  - en el visor de imágenes, la flecha izquierda pasa a la siguiente en
    árabe, como los botones, que también se reflejan;
  - las listas y los menús verticales no cambian: arriba y abajo no tienen
    lado;
  - las pestañas siguen siendo todas alcanzables con Tab, como antes (una
    prueba de arranque lo exige); las flechas se añaden, no sustituyen.
- **Menús y ventanas emergentes:** el punto de anclaje de un menú es su borde
  de inicio. `FloatingContextMenu` lo abre hacia la derecha en izquierda a
  derecha y hacia la izquierda en derecha a izquierda, siempre dentro de la
  ventana. Lo mide en el borde izquierdo de la ventana antes de colocarlo (un
  menú medido junto al borde derecho se estrecha y parte sus etiquetas) y lo
  vuelve a colocar cuando cambia de ancho (una fila que llega después). Los
  botones pasan el borde que corresponde (`startEdgeX`, `endAlignedX`,
  `besideEndX`, `flyoutX`); los submenús se abren pasado el borde final de su
  fila, o pasado el inicial si no caben. El panel de detalles en
  superposición entra desde el borde final. Los avisos (toasts) están
  centrados y no cambian.
- **El contenido de las personas conserva su dirección:**
  - asuntos, nombres, direcciones, etiquetas, títulos de eventos y tareas,
    nombres de carpeta y de archivo llevan `dir="auto"` (o `<bdi>` cuando el
    texto va dentro de una línea con texto de la interfaz): el navegador los
    ordena por sus propias letras y no reordenan lo que los rodea. En la
    tarjeta de la lista, la línea del asunto toma la dirección del asunto
    solo, no de la marca «Borrador» que va delante;
  - se alinean con la interfaz, no consigo mismos (`text-align: match-parent`
    para `[dir="auto"]`, sin especificidad, de modo que una clase de
    alineación explícita sigue mandando). Un asunto latino en la lista árabe
    queda a la derecha, pero se lee y se corta (con «…») por su propio final;
  - las listas de nombres en una frase («para Ana, Marc») aíslan cada nombre
    (marcas FSI/PDI) y en árabe se separan con la coma árabe «،». Una lista
    de izquierda a derecha en una interfaz de izquierda a derecha sale igual
    que antes;
  - el texto que alguien escribió y se lee o se escribe en varias líneas
    (cuerpos en texto plano, el redactor en texto y en formato, la respuesta
    rápida, el chat, las notas de eventos y contactos, las traducciones y
    reescrituras propuestas, los adjuntos de texto) toma la dirección de cada
    párrafo (`unicode-bidi: plaintext`) y se alinea con ella. Los campos
    vacíos siguen a la interfaz (`dir` solo cuando hay texto: un campo vacío
    con `dir="auto"` se quedaría de izquierda a derecha). El código, los
    registros, los scripts de reglas y las peticiones exactas al asistente
    son siempre de izquierda a derecha (`dir="ltr"`);
  - un mensaje HTML que declara su `dir` se respeta. En uno que no declara
    nada, cada bloque de texto (párrafo, elemento de lista, título, cita, y
    las celdas y `div` con texto propio) recibe `dir="auto"`; el `<body>`
    nunca: un boletín de izquierda a derecha cuyo primer texto es árabe (a
    menudo un preencabezado oculto) conserva sus tablas de maquetación de
    izquierda a derecha, y un mensaje que mezcla párrafos lee cada uno en su
    dirección;
  - **el correo que sale declara la dirección de sus bloques de derecha a
    izquierda:** al guardar y al enviar, cada párrafo, título, lista o cita
    cuyo primer carácter fuerte es de derecha a izquierda lleva `dir="rtl"`,
    y una cita así lleva la barra a la derecha (`border-right`,
    `padding-right`). Un párrafo de izquierda a derecha dentro de una lista o
    cita marcada lleva `dir="ltr"`. El correo escrito de izquierda a derecha
    sale byte a byte como antes (una prueba lo comprueba), y lo que ya
    declara su dirección (un original citado) no se toca. Así una respuesta
    en árabe sobre una cita en inglés llega a Outlook, Apple Mail o Gmail con
    cada parte en su dirección.
- **Accesibilidad hallada por las pruebas en árabe**, defectos que ya estaban
  en todos los idiomas y que se corrigen, aunque cambian lo que se ve en
  todos ellos:
  - contraste por debajo de 4,5:1 con el tema claro por opacidades sobre
    `text-secondary`: los metadatos de las filas de mensaje (fecha,
    destinatarios), la cabecera de la conversación, los títulos de grupo de
    la lista de calendarios y de la navegación de Ajustes. Se quitan esas
    opacidades (el texto secundario sigue siéndolo por color y peso);
  - los desplegables de Ajustes no tenían nombre accesible: toman el título
    de su fila;
  - dos contenedores de Ajustes (la firma y Actualizaciones) tenían
    `aria-label` sin rol: pasan a ser `role="group"`.

## Alternativas descartadas

- **Fusionar #198:** se cortó de un `main` antiguo (anterior a la agenda de
  la barra lateral, los separadores, la impresión y la presencia del chat) y
  no tenía pruebas.
- **Un plugin de PostCSS que invierta la hoja de estilos (rtlcss):** una
  dependencia nueva y una segunda hoja para mantener, cuando Tailwind ya
  tiene utilidades lógicas.
- **`Intl.Locale().textInfo` para saber la dirección:** no está en todos los
  motores en los que corre la aplicación.
- **`dir="auto"` en cada bloque del correo que sale (opción `textDirection`
  de Tiptap):** cambiaría el HTML de todos los mensajes enviados, en todos
  los idiomas, y los borradores guardados. Se declara solo la dirección de
  derecha a izquierda, que es la que un cliente no supone.
- **`dir="auto"` en el `<body>` del mensaje recibido** (la primera versión de
  esta decisión): giraba boletines enteros por un preencabezado árabe.
- **`Intl.ListFormat` para unir nombres:** en «unit» cambia el separador de
  otros idiomas («A y B» en español, ninguno en chino); se usa la coma del
  idioma y nada más.
- **Alinear el texto de las personas consigo mismo:** una lista árabe con
  unos asuntos a la derecha y otros a la izquierda se lee peor; la
  alineación sigue a la interfaz y la dirección al texto.
- **Pestañas con tabulación itinerante (solo la activa con Tab):** es el
  patrón WAI-ARIA, pero cambia el orden de Tab que ya usan las personas y las
  pruebas de arranque; las flechas se añaden sin quitar nada.

## Pendiente

- Prueba nativa en Windows con método de entrada árabe (ejecución N4 final):
  SET-27 no pasa a «verified» sin ella.
- Cambiar a mano la dirección de un párrafo en el redactor (Ctrl+Mayús+
  derecha/izquierda, como Word u Outlook): fuera de #226, en su propia issue.
- Arrastrar columnas del tablero (dnd-kit) en derecha a izquierda: el orden
  se calcula con rectángulos reales y el teclado mueve en el sentido de la
  flecha, pero falta comprobarlo en la aplicación nativa.
- Las líneas que mezclan texto de la interfaz y de las personas fuera de las
  revisadas aquí se revisarán con la prueba nativa.
