# ADR-0042: Archivos adjuntos en las notas

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-12.
- Alcance: #104, sobre ADR-0015.

## Decisión

- **Dónde se guardan:** dentro de la base del perfil, junto a la nota
  (`note_attachments`, esquema 57).
  - La copia completa del perfil (ADR-0017) los lleva sin más; la caché de
    adjuntos del correo, en cambio, queda fuera de esa copia.
  - Nada fuera del perfil tiene que volver a encontrarse.
- **Qué se guarda:** una copia del archivo elegido, hasta 25 MB por archivo
  y 50 por nota. El archivo original no se vuelve a tocar. Uno mayor se
  rechaza con la indicación de enlazarlo.
- **Guardar una copia:**
  - se escribe junto al destino y se renombra al terminar;
  - si algo falla, no queda un archivo cortado con el nombre elegido;
  - el nombre se reduce a un nombre de archivo, sin carpetas.
- **Papelera:**
  - mientras la nota está en la papelera, sus archivos se conservan y se
    pueden guardar, pero no añadir ni quitar;
  - al borrar la nota para siempre, o a los 30 días, se van con ella.
- **Quitar un archivo** pregunta antes y deja intacto el original.

## Alternativas descartadas

- **Guardarlos en la carpeta de medios:** esa carpeta es caché y la copia
  del perfil no la incluye, así que los adjuntos se perderían al restaurar.
- **Insertarlos en el HTML de la nota:** inflaría el texto, que tiene un
  límite de 8 MB y se busca entero.
