# Barra lateral contextual (#86)

El panel de detalles de una conversación (medios, archivos y
participantes) añade «Historial con …» para cada participante.

- **Qué muestra:** las conversaciones con esa dirección, las reuniones
  próximas en las que está (organizador o asistente) y los archivos que ha
  enviado. Cada elemento abre su origen: la conversación, el día en el
  calendario o el mensaje del archivo.
- **Aislamiento:** solo la cuenta de la conversación abierta. Otra cuenta
  que tenga correo de la misma persona no aparece, y una respuesta lenta
  para la cuenta anterior no se pinta en la nueva.
- **Dirección completa:** `ana@x.test` no coincide con `diana@x.test`. La
  consulta filtra por subcadena y después se comprueba la dirección
  exacta.
- **Lo que hay aquí:** se dice de cuántos mensajes guardados sale y cuántos
  tienen el cuerpo descargado, porque la historia antigua puede faltar.
- **Núcleo:** `meron-core/src/person_context.rs`, RPC `context.person`.

## Pruebas

- **Núcleo:**
  - una conversación por hilo, la más reciente primero;
  - sin Diana y sin otra cuenta;
  - reuniones futuras, sin pasadas ni canceladas.
- **Aplicación:**
  - cada elemento abre su origen;
  - aviso de historia parcial;
  - una respuesta tardía de otra cuenta no aparece.
- **Pendiente:** redimensionar el panel y recordar la última sección entre
  sesiones; ahora se recuerda abierto o cerrado como antes.
