# Traducción sin conexión (#106)

Registro de la implementación de ADR-0031.

## Piezas

- **Núcleo:**
  - `meron-core/src/translation/` tiene el registro fijo, la ruta (directa
    o por inglés), el estado, la descarga comprobada y atómica, la cuota y
    la limpieza al arrancar;
  - RPC `translation.status/download/cancel/remove`;
  - eventos `translation.progress` y `translation.done`; el error lleva un
    código (`cancelled`, `quota`, `diskFull`, `integrity`, `network`,
    `disk`).
- **Puente Go:** `MERON_MODELS_DIR` (caché de la instalación) y `/models/`,
  que no sirve carpetas que empiezan por punto.
- **Aplicación:**
  - `lib/translation.ts`: cliente del worker, comprobación de hashes,
    suposición de idioma y traductor (una petición cada vez, parada);
  - `states/translation.ts`: descargas con consentimiento y traducciones por
    mensaje;
  - `TranslationNotice`, `TranslateDraftDialog` y el grupo de Ajustes
    «Traducción».

## Pruebas

- **N1, núcleo:** archivo dañado, más largo de lo publicado, corte,
  cancelación, cuota, restos al arrancar, rutas y registro con rutas de
  archivo.
- **N1, aplicación:** ruta, suposición de idioma, comprobación de hashes,
  traductor, lector (elegir idiomas, mostrar y ver original, descarga
  rechazada o aceptada, error de integridad, par sin modelo) y diálogo de
  borrador (nada cambia hasta elegir; HTML con formato).
- **Motor real:** `build-tests/bergamot.check.mjs` arranca el worker y
  WebAssembly que se distribuyen y traduce español a inglés con el modelo
  publicado. CI lo baja con `scripts/fetch-translation-test-model.mjs`,
  comprobado contra el registro y guardado en caché.
- **N3 e2e:** en Chromium y con la CSP de producción, un borrador se traduce
  con el Bergamot real, se revisa y se añade debajo; no hay ninguna
  petición fuera de la aplicación.
