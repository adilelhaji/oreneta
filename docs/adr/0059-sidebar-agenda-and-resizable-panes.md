# ADR-0059: Agenda en la barra lateral, paneles redimensionables y sección recordada

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #212 en la opción más prudente); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #212 (fila SET-23 del libro de paridad, «Widgets» de eM Client
  10.4), sobre la barra lateral contextual de #86.

## Decisión

- **Dónde está la agenda:** es una sección más de la barra lateral de
  detalles de la conversación, junto a multimedia y archivos. Su contenido
  no depende de la conversación abierta ni espera a que cargue; el acceso
  sí: la barra lateral solo existe con una conversación abierta en el
  lector. No hay un panel de widgets independiente (al arrancar sin
  conversación, ni en Calendario, Tareas, Contactos o Notas); queda para
  una issue posterior, por decisión del propietario.
- **Qué muestra:**
  - los próximos 7 días, hoy incluido, contados por medianoches locales;
  - eventos de los calendarios activados de todas las cuentas con correo
    (el núcleo ya omite los desactivados); no se muestran los cancelados
    ni los terminados; uno en curso va en «Hoy»;
  - un evento de todo el día es una serie de fechas guardada a medianoche
    UTC (`allDayLocalDays`), así que se coloca por esas fechas y no por
    los instantes; termina cuando pasa su última fecha. A los calendarios
    se les pide un día más a cada lado para no perder esas fechas;
  - un evento de varios días aparece una vez, en su primer día dentro de la
    ventana (en «Hoy» si ya había empezado);
  - tareas abiertas con fecha de todas las listas (no hay listas
    desactivables); la fecha de una tarea es un día, nunca una hora, así
    que una de antes de hoy va primero, bajo «Vencidas»; sin fecha o
    terminadas no aparecen.
- **Orden:** «Vencidas», después cada día. Dentro de un día: eventos de
  todo el día, eventos por hora de inicio, y las tareas de ese día por
  prioridad (alta primero) y título.
- **Abrir:** un evento abre el calendario en vista de día, en su fecha (la
  de calendario para uno de todo el día), con el evento abierto en su
  ficha (`openCalendarOn`, compartida con las contrapropuestas). Una
  tarea abre su editor sobre lo que haya en pantalla; una tarea ligada a
  un mensaje conserva su conversación.
- **Lectura:** desde la caché, pidiendo al servidor que refresque detrás,
  como la vista de calendario. Se vuelve a leer cuando llega
  `calendar.synced`, cuando se cierra el editor de tareas o cambia la
  lista de tareas, y justo después de cada medianoche local, para que
  «Hoy», «Mañana» y «Vencidas» no se queden atrás. Solo cuenta la lectura
  más reciente. Si un calendario o la lista de tareas no se puede leer, se
  dice («puede estar incompleta»), nunca se muestra una semana más corta
  como completa.
- **Teclado:** cada elemento es un botón nativo; los días son regiones con
  nombre (su encabezado).
- **Redimensionar:** un separador vertical común (`PaneResizer`, rol
  `separator` con `aria-valuenow`, `aria-valuemin`, `aria-valuemax`)
  para la barra lateral, la lista de conversaciones y el panel de
  conversación del tablero:
  - puntero: arrastrar, con captura del puntero, para que pasar por encima
    del marco del lector no deje el arrastre colgado; termina al soltar,
    al cancelarse o al perder la captura. Teclado: flechas (16 px, o 2 % en
    el tablero; con Mayús, cuatro veces más), Inicio al mínimo y Fin al
    máximo;
  - de derecha a izquierda (árabe): las posiciones son lógicas (inicio y
    fin de la línea), y flechas y arrastre siguen la dirección que se lee;
  - límites: barra lateral 280–560 px, lista 280–560 px, panel del tablero
    25–60 %; un valor guardado fuera de límites (o que no es un número) se
    ajusta al leerlo;
  - el separador anuncia el tamaño dibujado, no el guardado: una lista
    estrechada por la ventana dice su ancho real, y su máximo es ese ancho
    (crecer más no se vería). En el tablero, el panel nunca baja de
    320 px, así que el porcentaje mínimo sube con una ventana estrecha; si
    no queda margen (o a 600 px o menos, donde ocupa todo), no hay
    separador;
  - la barra lateral va al lado del lector solo si la ventana mide al
    menos 1100 px **y** su fila deja al lector 360 px con la barra a
    280 px; se mide la fila, porque el panel de conversación del tablero
    puede ser estrecho en una ventana ancha. Al lado del lector, su máximo
    es el ancho que deja al lector 360 px, y el separador anuncia ese
    máximo. En los demás casos es una capa sobre el lector, con el ancho
    guardado y como mucho el 85 % de la ventana, sin separador;
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
- **Capa sobre la cabecera:** como capa, la barra lateral queda por encima
  de la cabecera de la conversación. Antes quedaba debajo y su propia
  cabecera (título, Atrás, Cerrar) no se veía.

## Alternativas descartadas

- **Agenda visible en todas las vistas, sin conversación abierta:** exige
  otro contenedor en el diseño de la aplicación (fuera del alcance de
  #212, que pide la barra lateral existente). Es lo que falta para la
  paridad de la fila SET-23.
- **Ventana de 1 o 30 días:** un día no avisa de mañana; treinta llenan la
  barra de lo que aún no importa. Siete cubre la semana que se planifica.
- **Mezclar tareas y eventos solo por hora:** la fecha de una tarea no tiene
  hora; ordenarla a medianoche la pondría antes de todo el día.
- **Repetir un evento de varios días en cada día:** en una barra estrecha
  multiplica las filas; el calendario ya lo muestra así.
- **Redimensionar también la capa estrecha:** a 600–1024 px la capa ya
  ocupa casi todo el lector; arrastrarla solo podría taparlo más.
- **Una librería de paneles:** el arrastre y el teclado son poco código y no
  justifican una dependencia nueva.

## Pruebas

- `frontend/src/lib/agenda.test.ts`: orden, filtros, días, ventana, y
  eventos de todo el día en UTC, São Paulo y Sídney.
- `frontend/src/lib/paneResize.test.ts`: límites, tamaño dibujado, cuándo
  va la barra al lado del lector, porcentajes del tablero.
- `frontend/src/components/chat/SidebarAgenda.test.tsx`: contenido,
  orden, abrir eventos y tareas, foco, aviso de incompleta, relecturas
  (sincronización, editor de tareas, medianoche).
- `frontend/src/components/resizer/PaneResizer.test.tsx`: puntero (también
  volver al tamaño de partida y pasar del máximo), captura perdida,
  teclado, derecha a izquierda, límites.
- `frontend/src/components/chat/ConversationDetailsPanel.test.tsx`: sección
  recordada y restaurada, ancho persistido y restaurado.
- `frontend/src/states/settings.test.ts`: tamaños guardados ajustados.
- `frontend/e2e/startup.e2e.ts`: entrada de producción a 600, 1024 y 1440
  px, claro y oscuro, texto al 200 % y equivalente de zoom del 200 %
  (720 px a escala 2, en São Paulo y Sídney), Intro sobre una tarea,
  límites a 600, 1100 y 1180 px con 560 px guardados, auditoría axe de la
  barra lateral y reinicio.
