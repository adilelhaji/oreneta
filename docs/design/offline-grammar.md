# Gramática sin conexión (#105)

Registro de la implementación de ADR-0030.

## Piezas

- `frontend/src/lib/grammar.ts`: `GrammarChecker` (una revisión a la vez,
  `stale` para la que queda adelantada, límite de tamaño, idioma, ignorados)
  y el adaptador sobre Harper (`engineFrom`, `harperEngine`).
- `frontend/src/components/composer/grammarExtension.ts`: el documento como
  texto con su mapa de posiciones, colocación de problemas, decoraciones que
  siguen al texto y aplicación de una sugerencia como una sola transacción.
- `GrammarPopover.tsx`: sugerencias, «Ignorar» y el estado (sin revisar por
  idioma, demasiado largo, no se pudo cargar).
- Ajuste `grammarCheck` (`grammar_check`), apagado por omisión.

## Pruebas

- N1 con el Harper real (el mismo WebAssembly): encuentra «I has», en la
  posición correcta aunque haya emoji, y no revisa un texto en español.
- N1 del editor: mapa de posiciones, edición única que se deshace y
  conserva el formato, subrayados que se mueven o se descartan.
- N3 e2e: activar en Ajustes, escribir, elegir la sugerencia y comprobar que
  no hubo ninguna petición fuera de la aplicación. Esa comprobación encontró
  que la fuente se pedía a Google Fonts; ahora va empaquetada.
