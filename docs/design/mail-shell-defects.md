# Shell de correo: defectos verificados y corregidos (iteración 5)

Revisión del shell de correo contra el código de la rama, con fecha 2026-10-10.
Cada defecto se reprodujo antes con una prueba que fallaba y se corrigió en su
propio commit. No sustituye a la evidencia nativa ni a las capturas de
referencia que pide la iteración.

## Corregidos

| Issue | Defecto | Corrección | Prueba |
|---|---|---|---|
| #34 | Un fallo en archivar, mover o borrar en lote deshacía también lo que el servidor ya había hecho. Marcar leído y estrella iban en paralelo sobre una lista que cambiaban todos. | Todas las acciones en lote van de una en una. Un fallo deshace solo esa conversación y se informa «n de m hechas, luego se detuvo: motivo». | `mail.test.ts` |
| #35 | Al imprimir se quitaba la política que bloquea imágenes remotas, el marco compartía el origen sin `sandbox` y faltaban los mensajes antiguos sin aviso. | CSP propia en la impresión, píxeles de seguimiento eliminados, marco con `sandbox` sin scripts y aviso cuando faltan mensajes. | `print.test.ts`, `printDocument.test.ts`, `bubbleHtml.test.ts` |
| #30 | Las vistas filtradas no ofrecían «cargar más» aunque hubiera más páginas. | `canLoadMoreThreads` lo decide por cursor y vista. | `listPaging.test.ts` |
| #36 | La cabecera de la tabla marcaba la columna elegida en vistas que el núcleo no ordena así: búsqueda, destacados, vista unificada con un feed. | Se marca el orden aplicado: la columna elegida en páginas por conversación y «más reciente primero» en el resto, con un aviso. | `ThreadTable.test.tsx`, `useThreadListLoader.test.tsx` |
| #36 | La vista de pospuestos de una cuenta va por hora de vuelta, pero al conservar la conversación abierta se reordenaba la página por fecha. | La conversación conservada vuelve a su posición sin reordenar. La tabla no marca ninguna columna en esa vista y la lista no agrupa por fecha. | `mailPaging.test.ts`, `ThreadTable.test.tsx` |
| #36 | Un ancho de lista guardado de 560 px dejaba el lector en 149 px a 769 px y en 185 px a 1025 px. | La lista cede hasta 280 px y el lector conserva al menos 360. En pantallas anchas se mantiene el ancho guardado. | e2e de producción a 769, 1024, 1025 y 1440 px |
| #36 | Una versión 1.5 de las vistas de buzón se leía como formato antiguo y el siguiente cambio la sobrescribía. | Cualquier versión mayor que 1 se trata como posterior y no se modifica. | `mailboxViews.test.ts` |
| #33 | El texto secundario de un tema personalizado sin editar quedaba en 3,43:1 sobre el fondo y en 2,94:1 sobre una fila seleccionada. | Se aclara solo hasta donde mantiene 4,5:1. El editor avisa, con la proporción, cuando los colores elegidos no lo permiten. | `themes.test.ts`, `ThemeEditorDialog.test.tsx` |
| #87 | Una carpeta creada desde Oreneta no tenía delimitador hasta la siguiente sincronización. Sus subcarpetas no contaban al borrarla. | Toma el delimitador de las demás carpetas de la cuenta. | `store::tests::a_folder_created_here_takes_the_account_delimiter_into_the_tree` |

## Decisiones que no se tomaron aquí

- **Orden del resto de fuentes.** El orden por remitente o asunto en búsqueda,
  destacados, pospuestos y vista unificada con feeds sigue sin contrato
  (ADR-0003). La interfaz ya no promete ese orden. Implementarlo es una
  decisión del núcleo, no un arreglo de interfaz.
- **Temas guardados.** Un tema personalizado guardado conserva sus colores
  hasta que se edita y se vuelve a guardar. Cambiarlo al cargarlo sería una
  migración de preferencias, que #33 pide explícita y reversible.

## Pendiente de la iteración

- **N2.** Capturas de referencia en claro y oscuro comparadas en cada
  anchura (599/600/601, 768/769, 1024/1025, 1440 y zoom al 200 %). Las pruebas
  de anchura existen; las capturas comparadas, no.
- **N3.** Orden estable entre páginas con llegadas concurrentes, contra maddy.
- **N4.** El flujo de lectura y organización en la app nativa.
- **#87.** Favoritos, colores de carpeta, arrastre seguro y deshacer verificado
  siguen sin evidencia completa.
