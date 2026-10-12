# ADR-0020: Lista de adjuntos sin índice de contenido

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #93.

## Contexto

#93 pide un espacio con todos los adjuntos, filtros y enlace a su mensaje.
Para buscar dentro de los archivos exige antes un diseño aislado y con
límites de recursos.

## Alternativas

1. **Lista leída de los metadatos que ya guarda cada mensaje descargado
   (elegida).** No hay un segundo índice que pueda desincronizarse, y la
   cobertura se dice siempre.
2. **Tabla propia de adjuntos mantenida en cada sincronización.** Es más
   rápida en buzones enormes, pero añade un estado que puede divergir. Se
   podrá añadir si las medidas lo piden.
3. **Indexar el contenido** (PDF, Office) en un proceso aparte. Necesita
   dependencias de análisis de documentos con historial de fallos de
   seguridad, y un proceso aislado con límites. Queda fuera hasta que se
   apruebe.

## Decisión

- **Origen:** la lista sale de `messages.json.attachments` de cada mensaje
  de correo descargado. Las imágenes sin nombre (logotipos y firmas dentro
  del texto) no se cuentan como archivos.
- **Filtros:** cuenta, palabras del nombre, remitente, tipo (deducido del
  tipo MIME o de la extensión), fecha y tamaño. Páginas de 200, con un
  máximo de 500.
- **Cobertura:** cada respuesta dice cuántos mensajes hay y cuántos están
  descargados; los demás tienen adjuntos que aquí no se conocen.
- **Archivos no disponibles:**
  - uno que ya no está en disco (la caché se poda) se lista sin clave, y se
    ofrece abrir su mensaje;
  - un enlace a la nube se dice tal cual.
- **Identidad:** cada archivo se identifica por cuenta, carpeta, UID e
  índice; la clave en disco incluye los mismos datos, de modo que una
  consulta antigua no puede abrir otro archivo.
- **Contenido:** no se busca dentro de los archivos, y la interfaz lo dice.

## Consecuencias

- Coste de la consulta: se recorren los mensajes descargados con adjuntos.
  Si un buzón grande lo hace lento, la alternativa 2 es el siguiente paso.
