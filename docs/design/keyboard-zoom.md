# Zoom con el teclado (#181)

Wails deja el WebView sin los atajos de zoom del navegador: Ctrl/⌘ con `+`,
`-` y `0` no hacen nada. El propietario decidió (2026-10-12) usar la escala
propia de la aplicación, no un `zoom` de CSS en la raíz.

## Cómo funciona

- **Atajos:**
  - Ctrl/⌘ `=` amplía. Ctrl/⌘ `+` también amplía, se escriba como se
    escriba (Mayús+`=` o la tecla `+` del teclado numérico).
  - Ctrl/⌘ `-` reduce y Ctrl/⌘ `0` vuelve al 100 %.
  - Están en *Atajos de teclado → Vista* y se pueden reasignar. Si se
    reasigna «ampliar», el `+` deja de ampliar también.
  - Funcionan aunque se esté escribiendo, como en un navegador: ninguno
    edita texto y los editores no usan ninguno de ellos.
  - También llegan desde el marco aislado de un mensaje HTML, que reenvía los
    atajos con Ctrl/⌘.
- **Escala:**
  - mueve el ajuste *Apariencia → Tamaño del texto* (`font_scale`), que
    cambia el tamaño de letra de la raíz;
  - con él crecen todos los textos y espacios medidos en rem;
  - los pasos son los de un navegador: 80, 90, 100, 110, 125, 150, 175 y
    200 %;
  - el máximo sube de 150 a 200 %, lo que exige WCAG 1.4.4;
  - un aviso dice el tamaño nuevo;
  - se guarda y vuelve tras reiniciar.
- **Por qué no `zoom` de CSS:** con `zoom` en la raíz, las media queries
  siguen midiendo la ventana en píxeles sin zoom, y el diseño adaptable deja
  de corresponderse con lo que se ve. Con la escala propia, las media
  queries siguen leyendo el ancho real.
- **Lo que no escala solo**, y se cambió para que lo haga:
  - la barra lateral medía 60 px fijos con botones en rem, y a 200 % los
    botones se salían por la izquierda; ahora mide `w-15` (3,75 rem);
  - en la cabecera de la conversación, los botones que dejan sitio cuando el
    panel es estrecho (destacar, no leído, asistente, y luego archivar y
    papelera) se ocultan según el ancho de la propia cabecera (por debajo de
    24 rem y de 20 rem; al 100 % se ven como antes en todos los anchos que
    prueba `mail boundary`), medido en rem
    con container queries. Antes dependían del ancho de la ventana en px. Todos
    siguen en el menú ⋮;
  - en el campo de destinatarios faltaba `min-w-0`, y el ancho natural del
    campo empujaba «Cc/Cco» fuera de la pantalla.
- **Lo que sigue en px:**
  - el ancho de los paneles que la persona arrastra;
  - el umbral de la búsqueda en la conversación (900 px), que va coordinado
    con la barra móvil y con un `matchMedia`.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`fonts.test.ts`) | Pasos de 100 a 200 % y vuelta; un tamaño escrito a mano va al paso más cercano en esa dirección; máximo 200 % |
| N1 (`shortcuts.test.ts`) | Ctrl/⌘ con `=`, `+` (con o sin Mayús), `-` y `0`; nunca sin la tecla de orden; reasignar «ampliar» quita también el `+`; sin choques con los atajos por omisión |
| N2 (`zoom.test.ts`) | El ajuste se mueve, la raíz pasa a 32 px a 200 % y vuelve; el aviso dice el tamaño |
| e2e (`startup.e2e.ts`, 1440 y 1024 px) | A 200 % no hay desplazamiento horizontal y ningún botón queda fuera de la pantalla en buzón, lector y redacción; Ctrl/⌘ `-` con el foco en un campo no toca el texto ni el foco; el tamaño vuelve tras recargar; Ctrl/⌘ `0` lo restablece |

Falta la prueba nativa (N4) en Windows, que se hará una sola vez con la
versión final.
