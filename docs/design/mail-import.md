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

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`archive/tests.rs`) | División de MBOX con LF y CRLF y deshecho de `>From`; importación con hilos y cuerpos sin servidor; duplicados; mover, copiar y borrar conservando los bytes; papelera; corpus difícil (encoded-words, Latin-1 sin charset, cabeceras plegadas, adjunto truncado, LF, sin Message-ID, PDF renombrado, archivo vacío) |
| N1 despachador (`main.rs`) | Una vista previa no crea nada; importar dos veces no duplica; el archivo no pide reconexión; carpetas, lectura del hilo y borrado a la papelera con las órdenes normales de correo |
| N2 (`MailImportDialog.test.tsx`) | Vista previa, cambio de carpeta, confirmación y aviso; el archivo nunca se ofrece como remitente |
| Guarda ADR-0011 | `archive_messages` se borra con la cuenta |
