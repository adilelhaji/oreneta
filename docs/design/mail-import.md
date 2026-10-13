# Importar correo al archivo local (#112, ADR-0014)

## Uso

**Ajustes → Copia de seguridad → Importar correo**:
1. Se eligen uno o varios `.eml` o `.mbox`.
2. Una vista previa indica cuántos mensajes se importarán, cuántos ya están
   en la carpeta y cuántos no son correo o superan el tamaño máximo. También
   permite elegir la carpeta del archivo.
3. Al confirmar, se importan.

La primera vez aparece la cuenta **Archivo local** en la barra lateral. Se
lee, se busca, se mueve y se borra como cualquier otra, pero no puede enviar
y no figura entre los remitentes.

## Desde Outlook (PST)

Oreneta no lee archivos `.pst` ni `.ost` directamente: no existe un lector en
Rust maduro y mantenido, y el propietario decidió (2026-10-12) no escribir uno
y documentar la conversión. `readpst` (libpst, GPL) convierte el archivo a
MBOX y el resultado se importa con lo que ya existe.

1. **Instalar `readpst`.**
   - Linux: el paquete `pst-utils` (Debian/Ubuntu: `sudo apt install pst-utils`;
     Fedora: `sudo dnf install libpst`).
   - macOS: `brew install libpst`.
   - Windows: dentro de WSL, como en Linux.
2. **Convertir** (Outlook cerrado, sobre una copia del archivo):

   ```sh
   readpst -8 -o salida/ "Outlook.pst"
   ```

   - Se crea un `.mbox` por carpeta: `Inbox.mbox`, `Sent Items.mbox`...
   - `-8` escribe los cuerpos en UTF-8 cuando Outlook guardó esa versión.
   - Los elementos borrados de Outlook no se incluyen; `-D` los añade.
   - Un `.pst` protegido con contraseña se lee igual: la contraseña de PST
     no cifra el contenido.
3. **Importar** de una de estas dos formas:
   - **Carpeta a carpeta**: *Ajustes → Copia de seguridad → Importar
     correo*, elegir un `.mbox` e indicar la carpeta del archivo (por
     ejemplo `Outlook/Bandeja de entrada`). Así cada carpeta queda con el
     nombre que se elija.
   - **Todo de una vez**: *Importar de Thunderbird → Elegir carpeta* y
     elegir `salida/`. Cada `.mbox` se ofrece como una carpeta; se marcan
     las que se quieran. La carpeta conserva el nombre del archivo, con
     `.mbox` al final, y se puede renombrar después.

Importar dos veces no duplica: los mensajes que ya están se saltan.

Calendario y contactos salen en archivos aparte, que el importador de correo
no toma por mensajes:
- `Calendar.calendar` es iCalendar: renombrado a `.ics`, se importa desde
  Calendario (*Importar ICS*).
- Con `-cv`, `Contacts.contacts` es vCard: renombrado a `.vcf`, se importa
  desde Contactos. Sin `-cv` es una lista de direcciones.

Probado con `readpst` 0.6.76 y los archivos de prueba públicos de
java-libpst (`example-2013.ost`, `dist-list.pst`): una carpeta por `.mbox`,
separadores `From "dirección" fecha` que el importador reconoce
(`archive/tests.rs`).

## Exportar (#112)

El menú de acciones de la lista (⋮) ofrece **Exportar carpeta como .mbox** en
cualquier carpeta de una cuenta IMAP o del archivo local. El núcleo escribe los
mensajes originales en formato mboxrd (cada línea `>*From ` gana un `>`) por
lotes de 50, en un `.part` junto al destino que solo se renombra al terminar:
un fallo a medias no deja un archivo truncado con el nombre elegido. Lo que se
exporta se vuelve a importar igual (prueba de ida y vuelta).

Graph y Exchange no entregan el mensaje original, así que allí no se ofrece;
guardar un solo mensaje como `.eml` ya existía.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`archive/tests.rs`) | División de MBOX con LF y CRLF y deshecho de `>From`; importación con hilos y cuerpos sin servidor; duplicados; mover, copiar y borrar conservando los bytes; papelera; corpus difícil (encoded-words, Latin-1 sin charset, cabeceras plegadas, adjunto truncado, LF, sin Message-ID, PDF renombrado, archivo vacío) |
| N1 despachador (`main.rs`) | Una vista previa no crea nada; importar dos veces no duplica; el archivo no pide reconexión; carpetas, lectura del hilo y borrado a la papelera con las órdenes normales de correo |
| N2 (`MailImportDialog.test.tsx`) | Vista previa, cambio de carpeta, confirmación y aviso; el archivo nunca se ofrece como remitente |
| N1 export (`archive/tests.rs`, `main.rs`) | mboxrd con LF, CRLF, `From ` y `>From` en el cuerpo se relee igual; exportar la carpeta o solo los elegidos; un destino imposible no deja `.part` |
| N2 export (`ExportFolder.test.tsx`, `mailCapabilities.test.ts`) | El elemento solo aparece donde se puede; cancelar no avisa; un fallo se dice; Graph, Exchange y RSS no exportan |
| N1 PST (`archive/tests.rs`) | La salida de `readpst` (separador `From "dirección"`, `>From` en el cuerpo) se divide en sus mensajes |
| Guarda ADR-0011 | `archive_messages` se borra con la cuenta |
