# Archivos en las notas (#104, ADR-0042)

## Uso

Debajo del texto de una nota, **Adjuntar un archivo…** guarda una copia del
archivo elegido. Cada archivo muestra su nombre y tamaño, con **Guardar** y
**Quitar**; quitar pregunta antes. En la papelera, los archivos se pueden
guardar pero no cambiar.

## Núcleo

- `meron-core/src/store/note_attachments.rs`.
- Órdenes: `notes.attachments`, `notes.attach`, `notes.removeAttachment` y
  `notes.saveAttachment`.
- El puente añade `notes.pickAttachment` y `notes.saveAttachmentAs`, que
  abren los diálogos del sistema.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`note_attachments.rs`) | Archivo guardado entero con su nombre y devuelto igual; cambiar el original no cambia la copia; sin `.part` al terminar; demasiado grande, inexistente, una carpeta o una nota inexistente se rechazan sin guardar nada; se conservan en la papelera, no se añaden a una nota en la papelera y se van al borrarla para siempre; un guardado fallido no deja archivo parcial; quitar solo una vez |
| N2 (`NoteAttachments.test.tsx`) | Lista, adjuntar el elegido, guardar por su nombre, quitar pregunta antes, en la papelera solo guardar |
| N4 pendiente | Diálogos del sistema en Windows |
