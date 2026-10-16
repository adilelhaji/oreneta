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
  vencidas, primero. Los eventos de todo el día van por su fecha, no por
  la hora UTC en que se guardan. Cada elemento abre el evento (calendario
  en su día) o la tarea (su editor). Si una fuente no se lee, lo dice; si
  el servidor de una cuenta no refresca, avisa de que puede estar
  desactualizada hasta que una sincronización de la semana lo logre. Se
  relee al sincronizar, al cerrar el editor de tareas y a medianoche.
- **Límite:** solo se llega a la agenda desde la barra lateral de una
  conversación abierta. No hay panel de widgets independiente (al arrancar
  sin conversación, ni en Calendario, Tareas, Contactos o Notas); por eso
  la fila SET-23 sigue `partial`.
- **Ancho:** al lado del lector (ventana ≥ 1100 px y fila con sitio para
  280 px más 360 px de lector) se arrastra o se mueve con el teclado entre
  280 y 560 px, sin dejar al lector menos de 360 px; se guarda entre
  reinicios. En otro caso es una capa sobre el lector, por encima de su
  cabecera, de como mucho el 85 % de la ventana. La lista de
  conversaciones y el panel del tablero usan el mismo separador, que dice
  el tamaño dibujado y sigue la dirección de lectura.
- **Sección:** se reabre en la última usada (resumen, multimedia, archivos o
  agenda), también tras reiniciar. El historial de una persona no se
  recuerda. Abierta o cerrada se recuerda como antes, solo en la sesión.
- **Pruebas:** `lib/agenda.test.ts`, `lib/paneResize.test.ts`,
  `SidebarAgenda.test.tsx`, `PaneResizer.test.tsx`,
  `ConversationDetailsPanel.test.tsx` y la entrada de producción (600,
  1024, 1100, 1180 y 1440 px, claro y oscuro, 200 %).
