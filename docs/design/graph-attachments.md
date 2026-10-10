# Adjuntos en Microsoft Graph (#142)

Bajo [ADR-0004](../adr/0004-microsoft-graph.md) y con los contratos existentes
de caché de medios y vista previa. No introduce almacenamiento nuevo: los
ficheros van a la caché de medios de siempre, con la misma ruta por cuenta,
carpeta y UID que IMAP y EWS.

## Lectura

- **Sin adjuntos.** El cuerpo sigue llegando como JSON y no cambia nada.
- **Con adjuntos.** Se lee el mensaje entero como MIME
  (`GET /me/messages/{id}/$value`) con el permiso de lectura (`Mail.Read`).
  Pasa por el mismo analizador que IMAP:
  - escribe cada parte en la caché de medios;
  - reescribe los `cid:` del HTML hacia esos ficheros;
  - deja el HTML para el saneado y la política de imágenes remotas de
    siempre.
  Leer el MIME no marca el mensaje como leído.
- **Tipos.**
  - Los adjuntos de fichero y los elementos adjuntos (un correo dentro de otro)
    viajan dentro del MIME y aparecen como siempre.
  - Los adjuntos de nube (`referenceAttachment`) son enlaces, no ficheros. Se
    listan aparte, sin bytes, con
    `GET /me/messages/{id}/attachments?$select=name,contentType,size,isInline`.
    Se muestran con su nombre y el motivo «Enlace en la nube — ábrelo en
    Outlook». Su enlace nunca se sigue y ningún token va a él.
  - Si ese listado falla, los ficheros que sí llegaron se muestran igualmente.
- **Límite.** El MIME se lee hasta 64 MiB (`MAX_MIME`). Se rechaza antes de
  leer si `Content-Length` lo supera, o se corta al superarlo. Entonces:
  - el texto se muestra desde el JSON;
  - la lista de adjuntos dice «Adjuntos no mostrados: este mensaje supera los
    64 MB que lee Oreneta»;
  - no se guarda nada a medias.
- **Caché.** Un mensaje con adjuntos solo se da por guardado si todos sus
  ficheros siguen en disco.
  - Una copia antigua sin ficheros, de antes de #142, se vuelve a leer.
  - Si falta un fichero borrado de la caché, se vuelve a pedir.
  - Un adjunto marcado como no disponible no fuerza relecturas.
- **Errores.** Un fallo de lectura es un error, nunca un mensaje vacío. Las
  categorías son las de Graph: 401, 403, 404, 429 con espera, 5xx y respuesta
  inválida.

## Aislamiento

- **Ruta por cuenta.** Los ficheros se escriben bajo
  `<medios>/<cuenta>/<carpeta>/<uid>/`, con los nombres saneados del
  analizador. Un mensaje de otra cuenta no puede escribir ni leer en esa ruta.
- **Identificador resuelto.** El identificador de Graph se resuelve por
  cuenta, carpeta y UID local antes de pedir nada. Un mensaje movido o borrado
  da «no encontrado», o la copia en caché si la hay.

## Pruebas

- **Transporte** (servidor de bucle local):
  - ruta `/$value` con un permiso de solo lectura;
  - límite de tamaño como `TooLarge`;
  - listado con `$select`, reconocimiento de enlaces y una sola petición, sin
    seguir el enlace;
  - una página JSON demasiado grande sigue siendo «respuesta inválida».
- **Sesión:**
  - MIME real con imagen en línea y PDF: ficheros en disco, HTML sin `cid:`
    y enlace de nube nombrado;
  - la segunda lectura sale de la caché;
  - un fichero borrado se vuelve a pedir;
  - un mensaje demasiado grande muestra el texto y el motivo;
  - sin adjuntos no se pide MIME;
  - un fallo es un error.
- **Interfaz:** un enlace de nube con tipo imagen se lista como ficha con su
  motivo y no se pierde.

## Límites

- **Lectura sin streaming.** El MIME se lee en memoria hasta el límite. Un
  mensaje más grande no muestra sus ficheros: para eso haría falta descargar
  cada adjunto por separado, que queda para después.
- **Descarga interrumpida.** Se trata como un fallo de lectura. La siguiente
  apertura vuelve a intentarlo.
- **Sin evidencia real.** La vista previa en el binario nativo y la
  certificación con un inquilino real quedan en #98.
