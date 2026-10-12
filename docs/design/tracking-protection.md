# Protección contra rastreadores (#107, ADR-0029)

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `privacy/tests.rs` | La copia incluida se lee y dice qué es; rastreadores de correo reales bloqueados e imágenes normales no; sintaxis (`\|\|`, `\|`, `^`, `*`, tipos, `domain=`, `third-party`, opciones que reescriben, cosméticas, expresiones regulares, excepciones, `important`, direcciones sin esquema, `data:` y `cid:`); un mensaje adverso (entidades, escapes CSS, `<style>`, `@import`, `background`, `srcset`) no pide nada a un rastreador y conserva imágenes normales y enlaces; actualización comprobada que, si falla, conserva la lista anterior; excepciones por mensaje y por cuenta |
| N2 `TrackerNotice.test.tsx` | Cuántos y cuáles con su regla; cargar en un mensaje solo tras confirmar, y deshacerlo; nada que mostrar; la lista en uso y la actualización solo bajo petición |

Mensajes de prueba sintéticos; ninguna prueba hace peticiones a la red.
