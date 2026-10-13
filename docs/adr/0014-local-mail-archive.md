# ADR-0014: Archivo local de correo e importación EML/MBOX

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #112 (importación y archivos de datos locales).
- Aprobación: el responsable delegó el 2026-10-11 las decisiones pendientes
  en la opción más prudente, que revisará al final (plan de finalización,
  «Modo de ejecución acordado»).

## Decisión

- Un **archivo local** es una cuenta más (`local-archive`, `auth_type`
  `local_archive`) cuyo «servidor» es la base de datos del perfil. No tiene
  contraseña, no sincroniza, no envía ni responde automáticamente, y nunca
  usa la red.
- Para el resto del núcleo es una variante más de la sesión de correo
  (`backend::Session::Local`), junto a IMAP, EWS y Graph. Así, listas,
  hilos, búsqueda, marcas, mover, copiar y borrar funcionan con el mismo
  código que en las demás cuentas.
- **Almacenamiento.** Cada mensaje se guarda dos veces en la base de datos
  cifrada del perfil:
  - analizado, en las mismas tablas que el correo sincronizado (cabeceras,
    cuerpo, adjuntos);
  - en sus bytes originales (`archive_messages`), para releerlo, exportarlo
    o copiarlo a un servidor tal como llegó.

  Entra en la copia completa del perfil (ADR-0010).
- **Importación** de `.eml` (un mensaje) y `.mbox` (varios, con `>From`
  deshecho), en dos pasos: vista previa y confirmación.
  - Los archivos se leen en el núcleo a partir de sus rutas y nunca se
    modifican.
  - Se rechazan los archivos de más de 1 GB y los mensajes de más de 100 MB.
  - Se omite lo que no es correo, y lo que ya está en la carpeta (mismo
    Message-ID) no se añade dos veces.
  - Lo importado queda como leído.
- **Borrar** mueve el mensaje a la papelera del archivo; borrar en la
  papelera lo elimina.
- **Copiar o mover entre el archivo y una cuenta** usa el flujo de copia
  existente: los bytes originales van y vienen.

## Alternativas descartadas

- **Carpetas en disco (Maildir).** Habrían quedado fuera del cifrado de la
  base de datos y de la copia completa, y requerían un segundo modelo de
  lectura.
- **Importar dentro de una cuenta IMAP.** Habría subido correo antiguo a un
  servidor sin que se pidiera.
- **PST (Outlook).** Es un formato propietario que no tiene una biblioteca
  madura en Rust. Queda como fila pendiente de #112, sin contar para la
  paridad.

## Pendiente (#112)

- Exportar a EML o MBOX.
- Importación por partes de archivos de más de 1 GB, y reanudación.
- Ajustes y perfiles de Thunderbird y Postbox.
- PST.
