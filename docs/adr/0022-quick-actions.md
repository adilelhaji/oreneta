# ADR-0022: Acciones rápidas

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #92.

## Contexto

#92 pide encadenar acciones sobre las conversaciones seleccionadas con un
solo gesto. Una cadena que envía, reenvía o borra puede hacer daño que no se
deshace, y una que se ejecuta sobre una selección que cambia mientras corre
puede tocar mensajes que nadie eligió.

## Decisión

- **Pasos permitidos:** marcar leído o no leído, destacar o quitar el
  destacado, archivar y mover a una carpeta. Nada de enviar, reenviar,
  responder, borrar ni llamar a otra acción rápida.
- **Archivar o mover va al final:** después de mover, la conversación ya no
  está donde los pasos siguientes la buscarían. El editor rechaza una cadena
  que lo incumple, y lo mismo hace la carga de los ajustes.
- **Límites:** hasta 8 pasos por acción y 9 acciones (Alt+1 … Alt+9).
- **Confirmación y conjunto fijo:** ejecutar pide confirmar y fija en ese
  momento las conversaciones afectadas. Lo que entre o salga de la selección
  después no cambia lo que se hace.
- **Cadena por conversación:** cada conversación recorre los pasos en orden y
  se detiene en el primero que falla; las demás siguen. Al terminar se
  muestra un informe paso a paso por conversación, con los fallos arriba.
- **Almacenamiento:** las acciones viven en los ajustes (`quick_actions`) y
  se sanean al cargar: lo que no cumple las reglas se descarta.

## Pendiente

- Etiquetas y categorías como pasos, cuando #91 y #95 fijen su contrato.
- Ejecutar sobre la conversación abierta sin selección explícita.
