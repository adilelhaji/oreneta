# ADR-0012: Edición de contactos y conflictos de escritura

- Estado: aceptada.
- Fecha: 2026-10-11.
- Alcance: #41. La política de conflictos se aplica también a tareas (#103) y
  a cualquier escritura nueva en calendario.
- Aprobación humana: «Local y después CardDAV» y «No guardar y mostrar ambas»,
  elegidas entre las opciones de
  [la propuesta](../design/contact-editing-decisions.md).

## Decisión

1. **Primero una libreta local** («en este equipo»), sin servidor.
2. **Después CardDAV**, con versión (ETag): `PUT` con `If-Match` y alta con
   `If-None-Match: *`, probada contra Radicale en CI. Las libretas sin permiso
   de escritura no ofrecen edición.
3. **Google y Exchange no se editan** en esta decisión. Google necesita el
   permiso `contacts`, que depende de los registros OAuth propios (#144).
   Exchange necesita evidencia de un servidor real.
4. **Conflictos.** Si el servidor responde que el elemento cambió, no se guarda
   nada: se relee la versión del servidor y se muestran las dos para que la
   persona elija. Nunca se fusiona ni se sobrescribe en silencio.
5. Borrado, duplicados, vCard y fotos según la propuesta: confirmación
   nombrando la libreta, enlace local deshacible y sin fotos por URL remota.

## Consecuencias

`people` necesita una columna de versión, rellenada en la siguiente
sincronización. Una libreta local queda solo en el equipo, y la interfaz lo
dice.
