# Plantillas y vistas previas fiables (#40)

## Fallos reproducidos

- **Plantilla de texto como HTML.** Una plantilla guardada solo como texto se
  insertaba en el editor enriquecido tal cual, como marcado. `a < b` rompía el
  cuerpo, `<b>` ponía negrita y los saltos de línea se perdían. Pasaba tanto en
  la plantilla de mensaje como en el fragmento insertado en el cursor. Un test
  existente fijaba ese comportamiento.
- **Plantilla HTML en el editor de texto.** Se quitaban las etiquetas con una
  expresión regular, así que `&amp;` llegaba literal y los párrafos se
  juntaban.
- **PDF de vuelta a la página 1.** El efecto de cambio de página ignoraba la
  página 1. Al pasar de la 2 a la 1, el lienzo seguía mostrando la 2 bajo el
  rótulo «1 de N».
- **PDF reabierto en cada render.** El diálogo pasaba un `onFailed` nuevo en
  cada render y era dependencia de la apertura, así que cualquier re-render
  cerraba el documento, lo reabría y devolvía al lector a la página 1.

## Contrato

- **Texto plano en el editor enriquecido.** Se escapa (`&`, `<`, `>`, `"`).
  Las líneas en blanco separan párrafos y un salto simple es `<br>`
  (`plainTextToHtml`). Una plantilla con HTML se inserta como HTML.
- **HTML en el editor de texto.** Se lee con el mismo `htmlToText` del resto de
  la app, con entidades decodificadas y párrafos separados.
- **Vista previa de PDF.**
  - **Al cambiar de fichero.** El documento se abre una vez por fichero y
    vuelve a la página 1. Una carga que resuelve tarde no pinta sobre el
    fichero nuevo; esa guarda ya existía y sigue probada.
  - **Al pasar página.** Cada página, la 1 incluida, se dibuja en el documento
    ya abierto.
  - **Al cerrar.** Cerrar el diálogo destruye la tarea de carga y su worker.
- **Error y descarga.** El diálogo dice «Este tipo de archivo no se puede
  mostrar aquí» o «No se pudo leer este adjunto», y «Guardar» está siempre en
  el pie. El diálogo se monta de nuevo para cada adjunto, así que un error no
  pasa de un fichero al siguiente.

## Pruebas

- `applyTemplate.test.ts`: escape y párrafos de una plantilla de texto en modo
  enriquecido, fragmento escapado, plantilla HTML intacta y HTML a texto con
  entidades. El test que fijaba el fallo se corrigió.
- `PdfPreview.test.tsx`: volver a la página 1 la redibuja; un re-render con
  callback nuevo no reabre ni cambia de página; cinco ciclos de abrir y cerrar
  destruyen cinco documentos; un documento que no abre se informa. Los dos
  primeros fallaban antes del cambio.

## Límites

- La medición de memoria retenida en ciclos repetidos (criterio 4 de #40)
  necesita el método acordado en el dispositivo de referencia (N6). Aquí solo
  se prueba que cada ciclo libera su documento y su worker.
- No se probó con PDFs malformados reales. La ruta de error se prueba con un
  `getDocument` que falla: se informa y se libera la tarea.
- Filtrar adjuntos por nombre, tipo o tamaño queda para después.
