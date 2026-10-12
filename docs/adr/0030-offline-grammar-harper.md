# ADR-0030: Corrección gramatical sin conexión con Harper

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12. Dentro de ADR-0001; sin
  telemetría nueva.
- Fecha: 2026-10-12.
- Alcance: #105.

## Decisión

- **Motor:**
  - Harper (`harper.js` 2.10.0, Apache-2.0), el que ya elegía ADR-0001;
  - corre en un worker, desde el WebAssembly que va con la aplicación
    (unos 16 MB, cargado la primera vez que se usa);
  - ningún texto sale del equipo; una prueba e2e falla si al revisar se hace
    cualquier petición fuera de la aplicación.
- **Idioma:**
  - solo inglés (americano, británico, canadiense y australiano), que es lo
    que Harper sabe;
  - un texto que no parece inglés no se revisa y se dice, en lugar de
    «corregirlo» con reglas de otro idioma.
- **Activación:**
  - apagada por omisión; se elige la variante de inglés en Ajustes;
  - no hay LanguageTool ni ningún servicio remoto: ADR-0001 lo deja fuera
    salvo como opción explícita por cuenta, y no se añade aquí.
- **En el editor:**
  - se revisa tras una pausa al escribir; una respuesta vieja nunca pinta
    sobre texto nuevo;
  - los subrayados son decoraciones: no entran en el borrador ni en el
    mensaje enviado;
  - un subrayado sigue al texto que se mueve y desaparece si cambia su
    propio texto;
  - nada cambia hasta que la persona elige una sugerencia, y eso es una
    sola edición que se deshace y conserva el formato;
  - «Ignorar» vale para esa redacción durante la sesión;
  - más de 20 000 caracteres no se revisan de una vez (una respuesta con un
    hilo largo citado), y se dice.
- **Fuente:** de paso, Inter deja de pedirse a Google Fonts y va empaquetada
  (`@fontsource-variable/inter` 5.3.0, OFL-1.1). Abrir la aplicación ya no
  hace ninguna petición a terceros.

- **Política de seguridad (CSP):**
  - se añade `'wasm-unsafe-eval'` a `script-src`, que permite compilar
    WebAssembly y no permite `eval` de JavaScript, y `worker-src 'self'
    blob:`, porque Harper arranca su worker desde una URL `blob:`;
  - se quitan los hosts de Google Fonts;
  - las pruebas e2e corren ahora con la política exacta de producción
    (`vite preview` la lee de `csp_prod.go`); así se vio que la primera
    versión no habría funcionado en la aplicación.

## Alternativas

- LanguageTool en un servidor: más idiomas, pero el texto sale del equipo.
- LanguageTool local (Java): pesado y con un proceso aparte.
- Hunspell solo: ortografía, no gramática; el corrector del sistema ya lo
  cubre en parte.

## Pendiente

- El editor de texto plano no tiene subrayados (un `<textarea>` no admite
  decoraciones); usa el corrector ortográfico del sistema.
- Otros idiomas, si Harper los añade.
- Diccionario personal que se guarde entre sesiones.
