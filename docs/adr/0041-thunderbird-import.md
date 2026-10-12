# ADR-0041: Importar desde Thunderbird

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-12.
- Alcance: importación desde otros clientes (paridad con el asistente de
  importación de eM Client); amplía ADR-0014.

## Decisión

- **Origen:** los perfiles de Thunderbird se buscan en sus sitios
  habituales:
  - `profiles.ini` en Windows (`%APPDATA%`), macOS, Linux, Flatpak y Snap;
  - también se puede elegir a mano un perfil o una carpeta de correo.
- **Qué se lee:**
  - cada carpeta de Thunderbird es un mbox sin extensión, con su índice
    `.msf` al lado, y sus subcarpetas están en `<nombre>.sbd/`;
  - se recorren `Mail/` (Carpetas locales y cuentas POP) e `ImapMail/`
    (copias de cuentas IMAP);
  - no se toman como correo los filtros, el estado POP, los índices sin
    carpeta ni los archivos vacíos.
- **Las copias IMAP no se eligen al principio:** ese correo sigue en su
  servidor y la copia puede estar incompleta. Se dice en el diálogo.
- **Mensajes borrados:** Thunderbird deja en el archivo los mensajes
  borrados hasta compactar, marcados con `X-Mozilla-Status` 0x0008. No se
  importan y se cuentan en la vista previa; nunca se recupera un correo que
  la persona borró.
- **Destino:** el archivo local (ADR-0014), en
  `Thunderbird/<cuenta>/<carpetas>`. Se sigue la misma regla de duplicados
  por Message-ID, así que importar dos veces no añade nada.
- **Vista previa obligatoria:** antes de guardar nada se dice, por carpeta,
  cuántos mensajes son nuevos, cuántos ya están y cuántos estaban borrados.
  Cambiar la selección pide otra vista previa.
- **Seguridad:**
  - solo se leen las carpetas que el escaneo encontró, por su identificador;
  - nada del perfil de Thunderbird se modifica;
  - un archivo de más de 1 GB se rechaza con la indicación de compactarlo
    o dividirlo, como en ADR-0014.

## Fuera de esta decisión

- **PST de Outlook:** no hay un lector en Rust maduro y mantenido. Sigue
  pendiente, a la espera de elegir uno (o de convertirlo fuera de
  Oreneta).
- **Libretas de direcciones y calendarios de Thunderbird:** se pueden
  exportar desde Thunderbird como vCard o `.ics` e importarlos con las
  funciones que ya existen.
