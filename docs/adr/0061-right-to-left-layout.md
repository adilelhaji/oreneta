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
  falla con cada uno nuevo. Se aceptan sin entrada en la lista: una clase
  emparejada en la misma línea con su contraparte `rtl:`/`ltr:`, y el
  centrado `left-1/2 -translate-x-1/2`, que cae en el mismo sitio en las dos
  direcciones. La lista de excepciones, cada una con su motivo:
  - las asas de las esquinas de una imagen en el redactor: sus nombres dicen
    «arriba a la izquierda» y el arrastre se calcula en píxeles de pantalla;
  - el estilo en línea de la cita del correo que sale: los clientes de correo
    (Outlook entre ellos) no admiten propiedades lógicas.
- **Iconos:** se reflejan los que apuntan a lo largo de la línea (flechas de
  atrás y adelante, chevrones, responder, reenviar, deshacer, enviar, la cita
  de una respuesta). No se reflejan los de medios, las marcas, las flechas de
  orden (arriba y abajo) ni los logotipos. Un chevrón girado con `rotate-*`
  ya apunta en vertical y no se refleja; `no-mirror` excluye un icono. Una
  sola regla en `index.css` por nombre de clase de Lucide, no un cambio en
  cada uso.
- **Teclado en el sentido de lectura:**
  - en los separadores de paneles (ya lo hacía `PaneResizer`, ADR-0059), en
    las pestañas (proveedores de cuenta, listas de tareas) y en los grupos de
    opción (tipo de calendario, color de categoría), las flechas laterales
    siguen la lectura: en árabe la flecha izquierda va al siguiente. Inicio y
    Fin van a los extremos; las pestañas y los grupos se recorren en círculo;
  - en el visor de imágenes, la flecha izquierda pasa a la siguiente en
    árabe, como los botones, que también se reflejan;
  - las listas y los menús verticales no cambian: arriba y abajo no tienen
    lado;
  - las pestañas siguen siendo todas alcanzables con Tab, como antes (una
    prueba de arranque lo exige); las flechas se añaden, no sustituyen.
- **Menús y ventanas emergentes:** el punto de anclaje de un menú es su borde
  de inicio. `FloatingContextMenu` lo abre hacia la derecha en izquierda a
  derecha y hacia la izquierda en derecha a izquierda, siempre dentro de la
  ventana. Los botones pasan el borde que corresponde (`startEdgeX`,
  `endAlignedX`, `besideEndX`, `flyoutX`); los submenús se abren pasado el
  borde final de su fila, o pasado el inicial si no caben. El panel de
  detalles en superposición entra desde el borde final. Los avisos (toasts)
  están centrados y no cambian.
- **El contenido de las personas conserva su dirección:**
  - asuntos, nombres, direcciones, etiquetas, nombres de carpeta y de
    archivo llevan `dir="auto"` (o `<bdi>` cuando el texto va dentro de una
    línea): el navegador los ordena por sus propias letras y no reordenan el
    texto de la interfaz que los rodea;
  - se alinean con la interfaz, no consigo mismos (`text-align: match-parent`
    para `[dir="auto"]`, sin especificidad, de modo que una clase de
    alineación explícita sigue mandando). Un asunto latino en la lista árabe
    queda a la derecha, pero se lee y se corta (con «…») por su propio final;
  - el texto que alguien escribió (cuerpos en texto plano, el redactor, las
    notas) toma la dirección de cada párrafo (`unicode-bidi: plaintext`) y se
    alinea con ella: una respuesta en árabe sobre una cita en inglés se lee
    bien en las dos partes. Los bloques de código son siempre de izquierda a
    derecha;
  - un mensaje HTML que declara su `dir` se respeta; uno que no declara nada
    recibe `dir="auto"` en el `<body>` de su marco. Un correo de izquierda a
    derecha nunca se gira, ni al revés;
  - los campos del asunto y de los destinatarios llevan `dir="auto"`.
- **Contraste:** las pruebas de arranque en árabe pasaron axe sin hallazgos
  graves salvo uno que ya existía en todos los idiomas: los metadatos de las
  filas de mensaje (fecha, destinatarios) y de la cabecera de la conversación
  con el tema claro, por debajo de 4,5:1 por opacidades sobre
  `text-secondary`. Se quitan esas opacidades (el texto secundario sigue
  siéndolo por color y peso).

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
  los idiomas, y los borradores guardados; se deja para su propia decisión
  (abajo).
- **Alinear el texto de las personas consigo mismo:** una lista árabe con
  unos asuntos a la derecha y otros a la izquierda se lee peor; la
  alineación sigue a la interfaz y la dirección al texto.
- **Pestañas con tabulación itinerante (solo la activa con Tab):** es el
  patrón WAI-ARIA, pero cambia el orden de Tab que ya usan las personas y las
  pruebas de arranque; las flechas se añaden sin quitar nada.

## Pendiente

- Prueba nativa en Windows con método de entrada árabe (ejecución N4 final):
  SET-27 no pasa a «verified» sin ella.
- La dirección de cada párrafo en el correo que sale (`dir` en el HTML
  enviado): hoy el redactor muestra cada párrafo en su dirección, pero el
  HTML enviado no la declara.
- Los sitios con texto de las personas fuera del correo (agenda, contactos,
  tareas, notas, chat) llevan `dir="auto"` donde el texto va solo en un
  elemento que se corta; las líneas que mezclan texto de la interfaz y de
  las personas se revisarán con la prueba nativa.
