# ADR-0015: Notas locales

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #104.

## Contexto

#104 pide notas independientes con texto enriquecido, imágenes, adjuntos,
etiquetas y búsqueda, y después sincronización con Exchange, Office 365,
IceWarp o CalDAV. Exige decidir antes la identidad y el almacenamiento.

## Alternativas

1. **Notas locales sin cuenta (elegida).** Se guardan en la base cifrada del
   equipo con un identificador propio (`note:<uuid>`). Ninguna cuenta las
   posee, así que quitar una cuenta no las toca (ADR-0011).
2. **Notas dentro de una cuenta desde el principio.** Obliga a elegir ya el
   modelo de cada proveedor y deja sin notas a quien solo tiene IMAP.
3. **Notas como borradores o mensajes IMAP en una carpeta «Notes»**, como
   hace Apple Mail. Funciona en cualquier servidor, pero mezcla notas con
   correo, depende de la red para guardar y expone las notas a quien lea el
   buzón.

## Decisión

- El cuerpo es HTML limpiado al guardar: se conserva el formato del editor;
  se quita todo lo que se ejecuta o llama a la red (scripts, manejadores,
  `javascript:`, imágenes remotas, `data:` fuera de `<img>`). Las imágenes
  van dentro de la nota como `data:image/…`. Junto al cuerpo se guarda su
  texto plano para buscar.
- Límites: 8 MB por nota con imágenes, 5 MB por imagen añadida, 20
  etiquetas de hasta 40 caracteres. Lo que los supera se rechaza; no se
  recorta.
- Cada escritura nombra la revisión de la que parte. Si la nota cambió en
  otra ventana, no se escribe nada y se muestran las dos versiones (política
  de ADR-0012). Si se borró del todo, se ofrece guardarla como nota nueva.
- Borrar mueve a la papelera; desde allí se restaura o se borra del todo. La
  papelera olvida las notas tras 30 días.
- Sin adjuntos de archivo ni sincronización en esta entrega. La interfaz
  dice «Solo en este equipo».

## Consecuencias

- Los proveedores se añaden después como fuentes con su propia identidad
  remota, igual que los contactos (ADR-0012): una nota local no se sube sola.
  Exchange necesita grabaciones reales antes de implementarse.
- Los adjuntos de archivo necesitan almacenamiento fuera de la fila (la copia
  de seguridad de ADR-0010 tendrá que incluirlos); se deciden con la
  sincronización.
