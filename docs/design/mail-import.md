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
| Guarda ADR-0011 | `archive_messages` se borra con la cuenta |
