# ADR-0029: Protección contra rastreadores con EasyPrivacy

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Dentro de ADR-0001; sin
  telemetría nueva.
- Fecha: 2026-10-12.
- Alcance: #107.

## Decisión

- **Lista:**
  - una copia fija de EasyPrivacy, `easylist/easylist@4b79596e`, va con la
    aplicación, con su procedencia, su hash y su licencia (GPL-3.0+ o
    CC BY-SA 3.0+);
  - solo se descarga una nueva cuando la persona lo pide, y únicamente
    desde `easylist.to`;
  - antes de usarla se comprueba el título, el tamaño y el número de
    reglas, se escribe junto a la anterior y se renombra; si algo falla,
    sigue la lista que había;
  - se puede volver a la incluida.
- **Dónde actúa:**
  - en el núcleo, al preparar el HTML para leer, dentro del saneado
    (ammonia), que ya entrega los valores decodificados; así una dirección
    escrita con entidades se reconoce como cualquier otra;
  - se comprueban `src`, `background`, `poster`, `srcset` y `style`, y
    `url()` e `@import` en los bloques `<style>`, también con escapes CSS;
  - una imagen bloqueada no carga nada; un fondo o una hoja bloqueados se
    quitan;
  - los enlaces no se tocan: seguir uno es decisión de quien lee.
- **Qué reglas:**
  - solo las de red que pueden aplicarse a un correo;
  - se omiten las cosméticas, las expresiones regulares, las que reescriben
    peticiones y las limitadas a un sitio web, que no existe en un correo;
  - omitir solo puede dejar de bloquear algo, nunca bloquear más de lo que
    dice la lista;
  - se respetan las excepciones (`@@`) y `important`.
- **Visible:**
  - el mensaje dice cuántos rastreadores se bloquearon y, si se pide, cuáles
    y con qué regla.
- **Excepción por mensaje:**
  - «Cargarlos en este mensaje» pregunta antes y se guarda por cuenta y
    Message-ID;
  - no cambia la política de imágenes remotas de la cuenta, que el CSP sigue
    imponiendo;
  - un mensaje sin Message-ID no puede tener excepción.
- **Confirmaciones de lectura:** la aplicación no envía ninguna.
- **Sin red en las pruebas:** las pruebas nunca contactan con un rastreador
  ni con easylist.to.

## Pendiente

- Quitar los parámetros de seguimiento de los enlaces (`removeparam`), con
  aviso.
- Medir y, si hace falta, acelerar la comprobación de mensajes con cientos
  de imágenes (unos 0,4 ms por dirección en compilación optimizada).
