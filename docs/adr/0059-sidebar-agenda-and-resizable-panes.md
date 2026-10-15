# ADR-0059: Agenda en la barra lateral, paneles redimensionables y sección recordada

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #212 en la opción más prudente); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #212 (fila SET-23 del libro de paridad, «Widgets» de eM Client
  10.4), sobre la barra lateral contextual de #86.

## Decisión

- **Dónde está la agenda:** es una sección más de la barra lateral de
  detalles de la conversación, junto a multimedia y archivos. El resumen
  muestra siempre la fila «Agenda»; no depende de la conversación abierta
  ni espera a que cargue.
- **Qué muestra:**
  - los próximos 7 días, hoy incluido, contados por medianoches locales;
  - eventos de los calendarios activados de todas las cuentas con correo
    (el núcleo ya omite los desactivados); no se muestran los cancelados
    ni los terminados; uno en curso, o uno de varios días empezado antes,
    va en «Hoy»;
  - tareas abiertas con fecha de todas las listas (no hay listas
    desactivables); la fecha de una tarea es un día, nunca una hora, así
    que una de antes de hoy va primero, bajo «Vencidas»; sin fecha o
    terminadas no aparecen.
- **Orden:** «Vencidas», después cada día. Dentro de un día: eventos de
  todo el día, eventos por hora de inicio, y las tareas de ese día por
  prioridad (alta primero) y título.
- **Abrir:** un evento abre el calendario en vista de día, en su fecha, con
  el evento abierto en su ficha. Una tarea abre su editor sobre lo que
  haya en pantalla; una tarea ligada a un mensaje conserva su conversación.
- **Lectura:** desde la caché, pidiendo al servidor que refresque detrás,
  como la vista de calendario; cuando llega `calendar.synced` se vuelve a
  leer la caché. Si un calendario o la lista de tareas no se puede leer, se
  dice («puede estar incompleta»), nunca se muestra una semana más corta
  como completa.
- **Teclado:** cada elemento es un botón nativo; los días son regiones con
  nombre (su encabezado).
- **Redimensionar:** un separador vertical común (`PaneResizer`, rol
  `separator` con `aria-valuenow`, `aria-valuemin`, `aria-valuemax`)
  para la barra lateral, la lista de conversaciones y el panel de
  conversación del tablero:
  - puntero: arrastrar; teclado: flechas (16 px, o 2 % en el tablero; con
    Mayús, cuatro veces más), Inicio al mínimo y Fin al máximo;
  - límites: barra lateral 280–560 px, lista 280–560 px, panel del tablero
    25–60 %; un valor guardado fuera de límites se ajusta al leerlo;
  - la barra lateral solo se redimensiona cuando está al lado del lector
    (≥ 1100 px). Ahí su máximo es además el ancho que deja al lector
    360 px, y el separador anuncia ese máximo. Por debajo es una capa
    sobre el lector, con el ancho guardado y como mucho el 85 % de la
    ventana, sin separador;
  - los tamaños son preferencias (`details_panel_width`,
    `thread_list_width`, `kanban_pane_width`) y se conservan entre
    reinicios.
- **Sección recordada:** la última sección (resumen, multimedia, archivos o
  agenda) se guarda en `session_sidebar_section_main`. La aplicación tiene
  una sola ventana, la principal; la clave lleva su nombre para que otra
  ventana, si se añade, tenga la suya. El historial de una persona no se
  recuerda: necesita a esa persona, que puede no estar en la siguiente
  conversación; se muestra encima de la sección y se cierra al cambiar de
  conversación. Cambiar de conversación ya no devuelve al resumen.
- **Capa sobre la cabecera:** como capa (< 1100 px), la barra lateral queda
  por encima de la cabecera de la conversación. Antes quedaba debajo y su
  propia cabecera (título, Atrás, Cerrar) no se veía.

## Alternativas descartadas

- **Agenda visible en todas las vistas, sin conversación abierta:** exige
  otro contenedor en el diseño de la aplicación (fuera del alcance de
  #212, que pide la barra lateral existente).
- **Ventana de 1 o 30 días:** un día no avisa de mañana; treinta llenan la
  barra de lo que aún no importa. Siete cubre la semana que se planifica.
- **Mezclar tareas y eventos solo por hora:** la fecha de una tarea no tiene
  hora; ordenarla a medianoche la pondría antes de todo el día.
- **Redimensionar también la capa estrecha:** a 600–1024 px la capa ya
  ocupa casi todo el lector; arrastrarla solo podría taparlo más.
- **Una librería de paneles:** el arrastre y el teclado son poco código y no
  justifican una dependencia nueva.

## Pruebas

- `frontend/src/lib/agenda.test.ts`: orden, filtros, días, ventana.
- `frontend/src/components/chat/SidebarAgenda.test.tsx`: contenido,
  orden, abrir eventos y tareas, teclado, aviso de incompleta, recarga.
- `frontend/src/components/resizer/PaneResizer.test.tsx`: puntero, teclado,
  límites.
- `frontend/src/components/chat/ConversationDetailsPanel.test.tsx`: sección
  recordada y restaurada, ancho persistido y restaurado.
- `frontend/src/states/settings.test.ts`: tamaños guardados ajustados.
- `frontend/e2e/startup.e2e.ts`: entrada de producción a 600, 1024 y 1440
  px, claro y oscuro, texto al 200 % y equivalente de zoom del 200 %
  (720 px a escala 2), con auditoría axe de la barra lateral y reinicio.
