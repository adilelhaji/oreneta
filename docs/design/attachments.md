# Adjuntos (#93, ADR-0020)

## Uso

El icono del clip de la barra lateral abre **Adjuntos**: todos los archivos
del correo descargado, del más reciente al más antiguo. Se filtran por
nombre, remitente, tipo, fecha y cuenta. Cada fila ofrece vista previa
(cuando el tipo la admite), guardar y abrir su mensaje.

Si hay correo sin descargar, un aviso dice cuántos mensajes faltan: sus
adjuntos no están en la lista. Un archivo que ya no está en disco se puede
recuperar abriendo su mensaje.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `store/attachment_list/tests.rs` | Lista con origen, sin imágenes en línea; archivo sin descargar y enlace a la nube; cobertura; filtros por cuenta, nombre (palabras), remitente, tipo, fechas y tamaño; `%` literal; páginas y límite máximo; tipo por MIME o extensión |
| N2 `AttachmentsView.test.tsx` | Lista, recuento, aviso de cobertura, guardar solo lo que está en disco, abrir el mensaje; filtros enviados al núcleo; una respuesta antigua no pisa una nueva |
| N6 `startup.e2e.ts` | Auditoría axe de la vista en claro y oscuro |
