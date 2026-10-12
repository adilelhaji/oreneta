# ADR-0011: Qué se borra al eliminar una cuenta

- Estado: aceptada.
- Fecha: 2026-10-11.
- Alcance: `store::delete_account`; hallazgo de la validación de #42.
- Aprobación humana: «Borrar todo salvo tu contenido», elegida entre las
  opciones presentadas el 2026-10-11 (borrar todo salvo el contenido, preguntar
  al eliminar, borrar absolutamente todo, dejarlo como está).

## Decisión

Al eliminar una cuenta se borran en la misma transacción todo su estado y sus
datos personales:
- etiquetas, pospuestos, prioridad, spam y reglas con su registro;
- contactos sincronizados, sus libretas y los correspondientes;
- registros de respuestas automáticas y de recordatorios;
- tareas.

Se conserva el contenido escrito por la persona: borradores locales, envíos
programados e intentos de envío. Un intento de resultado incierto es además la
evidencia de #29 de que un mensaje pudo salir. La app avisa de que ese
contenido sigue en el equipo y permite exportarlo o borrarlo explícitamente.
Nunca se envía nada de una cuenta eliminada.

## Consecuencias

- Una prueba recorre todas las tablas con columna de cuenta y falla si alguna
  no está en la lista de borradas ni en la de conservadas. Así, una tabla nueva
  no puede quedarse fuera sin decidirlo.
- Los envíos programados de una cuenta eliminada no se ejecutan, porque no hay
  credenciales; quedan como contenido conservado.
