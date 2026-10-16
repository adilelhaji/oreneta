# Derecha a izquierda (#226)

Fila SET-27 del libro de paridad (General → Idioma). Decisiones:
[ADR-0061](../adr/0061-right-to-left-layout.md).

Código: `frontend/src/lib/direction.ts`, `lib/physicalDirection.ts` (el
guardián), `states/settings.ts` (`applyDocumentLanguage`), `index.css`.

## Cómo se escribe un componente

- **Lados lógicos siempre:** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `border-s`/`border-e`, `rounded-s`/`rounded-e` (y `rounded-ss/se/es/ee`),
  `text-start`/`text-end`; en CSS, `margin-inline-start`,
  `inset-inline-end`, etc. `bun test` falla con un `ml-2`, un `left-0` o un
  `paddingLeft` nuevo en `src/components` o `App.tsx`.
- **Cuando no hay forma lógica** (`translate-x`, una sombra interior), se
  escribe la otra dirección al lado: `translate-x-4 rtl:-translate-x-4`, o
  una regla `[dir='rtl']` en `index.css`.
- **Una excepción es una decisión:** va a `ALLOWED` en
  `lib/physicalDirection.test.ts` con su motivo, y la prueba avisa si deja de
  usarse.
- **Texto de las personas:** `dir="auto"` en el elemento que lo contiene
  solo (y que lo corta con `truncate`), `<bdi>` si va dentro de una línea con
  texto de la interfaz. Se alinea con la interfaz por sí solo.
- **Texto largo que alguien escribió:** la clase `bidi-plaintext` (o
  `.tiptap-body`) da a cada párrafo su propia dirección.
- **Código:** `dir="ltr"`.

## Lo que mira la dirección en tiempo de ejecución

| Qué | Cómo |
|---|---|
| Flechas laterales en pestañas y grupos de opción | `handleGroupArrowKeys` (lee la dirección del elemento) |
| Flechas del visor de imágenes | `inlineArrowStep` con `documentDirection()` |
| Separadores de paneles | `PaneResizer` (ADR-0059) |
| Menús contextuales y desplegables | `FloatingContextMenu` + `startEdgeX`, `endAlignedX`, `besideEndX`, `flyoutX` |
| Menú rápido, ventana de gramática | `menuLeft` |
| Mensajes HTML en su marco | `applyContentDirection` (`dir="auto"` si el mensaje no declara nada) |

## Iconos

Se reflejan en derecha a izquierda, por su clase de Lucide (`index.css`):
flechas izquierda/derecha, chevrones, `corner-down-*`, responder, reenviar,
deshacer/rehacer, enviar, cita de texto, entrar/salir. Un icono con una
clase `rotate-*` o `no-mirror` no se refleja.

## Pruebas

- `lib/direction.test.ts`, `lib/physicalDirection.test.ts`: la lógica y el
  guardián.
- `components/readingDirection.test.tsx`: teclado en pestañas y en el visor,
  y la colocación de un menú.
- `components/mixedDirection.test.tsx`: asunto latino en la interfaz árabe y
  asunto árabe en la inglesa; cambio de idioma sin recargar.
- `e2e/startup.e2e.ts` («#226»): la entrada de producción en árabe a 600,
  1024 y 1440 px, en tema claro y oscuro, al 100 % y al 200 % (zoom propio,
  #181), con axe; la vuelta al inglés sin recargar; un asunto árabe en la
  interfaz inglesa.
