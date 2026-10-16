# Derecha a izquierda (#226)

Fila SET-27 del libro de paridad (General → Idioma). Decisiones:
[ADR-0061](../adr/0061-right-to-left-layout.md).

Código: `frontend/src/lib/direction.ts`, `lib/physicalDirection.ts` (el
guardián), `states/settings.ts` (`applyDocumentLanguage`),
`components/composer/composerHelpers.ts` (`inlineRichStyles`, el correo que
sale), `index.css`.

## Cómo se escribe un componente

- **Lados lógicos siempre:** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `border-s`/`border-e`, `rounded-s`/`rounded-e` (y `rounded-ss/se/es/ee`),
  `text-start`/`text-end`; en CSS, `margin-inline-start`,
  `inset-inline-end`, etc. `bun test` falla con un `ml-2`, un `left-0` o un
  `paddingLeft` nuevo en `src/components` o `App.tsx`. No mira las
  coordenadas en objetos `style`, ni `src/lib`, ni `index.css`.
- **Cuando no hay forma lógica** (`translate-x`, una sombra interior), se
  escribe la otra dirección al lado: `translate-x-4 rtl:-translate-x-4`, o
  una regla `[dir='rtl']` en `index.css`.
- **Una excepción es una decisión:** va a `ALLOWED` en
  `lib/physicalDirection.test.ts` con su motivo, y la prueba avisa si deja de
  usarse.
- **Texto de las personas:** `dir="auto"` en el elemento que lo contiene
  solo (y que lo corta con `truncate`), `<bdi>` si va dentro de una línea con
  texto de la interfaz. Se alinea con la interfaz por sí solo. Varios nombres
  en una frase: `formatNameList` (o `nameSeparator` con un `<bdi>` por nombre).
- **Texto largo que alguien escribió:** `dir="auto"` y la clase
  `bidi-plaintext` (o `.tiptap-body`) dan a cada párrafo su propia dirección.
  En un campo, `dir={valor ? 'auto' : undefined}`: vacío, sigue a la interfaz.
- **Código, registros, peticiones exactas:** `dir="ltr"`.
- **Flechas como texto:** `forwardArrow()` / `backArrow()`, no «→» / «←».

## Lo que mira la dirección en tiempo de ejecución

| Qué | Cómo |
|---|---|
| Flechas laterales en pestañas y grupos de opción | `handleGroupArrowKeys` (lee la dirección del elemento) |
| Flechas del visor de imágenes | `inlineArrowStep` con `documentDirection()` |
| Separadores de paneles | `PaneResizer` (ADR-0059) |
| Menús contextuales y desplegables | `FloatingContextMenu` + `startEdgeX`, `endAlignedX`, `besideEndX`, `flyoutX` |
| Menú rápido, ventana de gramática | `menuLeft` |
| Mensajes HTML en su marco | `applyContentDirection` (`dir="auto"` en cada bloque de texto si el mensaje no declara nada) |
| Correo que sale | `markRightToLeftBlocks` desde `inlineRichStyles` (`dir="rtl"` y cita con la barra a la derecha) |

## Iconos

Se reflejan en derecha a izquierda, por su clase de Lucide (`index.css`):
flechas izquierda/derecha, chevrones, `corner-down-*`, responder, reenviar,
deshacer/rehacer, enviar, cita de texto, entrar/salir, paneles laterales,
listas y ajuste de línea. Un icono con una clase `rotate-*` o `no-mirror` no
se refleja; un chevrón de desplegar con `transition-transform` se gira 180°.

## Pruebas

- `lib/direction.test.ts`, `lib/physicalDirection.test.ts`: la lógica, la
  dirección de los mensajes (un boletín con preencabezado árabe sigue de
  izquierda a derecha) y el guardián.
- `components/composer/composerHelpers.test.ts`: el correo que sale; el de
  izquierda a derecha, byte a byte igual.
- `components/readingDirection.test.tsx`, y las pruebas de pestañas y grupos
  en `TaskLists`, `CalDavCalendars` y `Categories`: teclado y colocación de
  un menú.
- `components/mixedDirection.test.tsx`: asunto latino en la interfaz árabe y
  asunto árabe en la inglesa, con la dirección resultante; cambio de idioma
  sin recargar.
- `e2e/startup.e2e.ts` («#226»), en la entrada de producción en árabe:
  - correo, lector y redactor a 600, 1024 y 1440 px, en tema claro y oscuro,
    al 100 % y al 200 % (zoom propio, #181), con axe;
  - personas, tareas, notas, calendario, chat y ajustes a 600 y 1024 px, en
    los dos temas, sin desbordar por ningún lado y con axe;
  - un menú contextual abierto junto al borde derecho: entero y sin
    etiquetas partidas;
  - la vuelta al inglés sin recargar, y un asunto árabe en la interfaz
    inglesa.
