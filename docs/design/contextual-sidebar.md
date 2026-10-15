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

## Agenda, ancho y sección recordada (#212, ADR-0059)

- **Agenda:** sección de la barra con los eventos de los calendarios
  activados y las tareas con fecha de los próximos 7 días; las tareas
  vencidas, primero. Cada elemento abre el evento (calendario en su día) o
  la tarea (su editor). Si una fuente no se lee, lo dice.
- **Ancho:** al lado del lector (≥ 1100 px) se arrastra o se mueve con el
  teclado entre 280 y 560 px, sin dejar al lector menos de 360 px; se
  guarda entre reinicios. Más estrecha es una capa sobre el lector, por
  encima de su cabecera, de como mucho el 85 % de la ventana. La lista de
  conversaciones y el panel del tablero usan el mismo separador.
- **Sección:** se reabre en la última usada (resumen, multimedia, archivos o
  agenda), también tras reiniciar. El historial de una persona no se
  recuerda. Abierta o cerrada se recuerda como antes, solo en la sesión.
- **Pruebas:** `lib/agenda.test.ts`, `SidebarAgenda.test.tsx`,
  `PaneResizer.test.tsx`, `ConversationDetailsPanel.test.tsx` y la entrada
  de producción (600, 1024 y 1440 px, claro y oscuro, 200 %).
