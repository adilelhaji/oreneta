# ADR-0051: Semana y horario laboral del calendario

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-18 de la paridad con eM Client 10.4 (#100),
  «Calendario → General». Las vistas de agenda, semana y mes, el cambio de
  hora y los calendarios locales, de Google, Exchange y CalDAV ya estaban
  resueltos y probados; faltaban el primer día de la semana, el horario
  laboral y lo que trae un evento nuevo. El tiempo meteorológico queda fuera
  (ver «Pendiente»).

## Decisión

- **Dos filas en `settings`:**
  - `calendar_week_start` (`settings$.calendarWeekStart`): `locale`,
    `sunday`, `monday` o `saturday`. Va sola y como texto plano para que el
    móvil pueda leerla con `app.prefsGet` sin entender un objeto;
  - `calendar_general` (`settings$.calendar`): números de semana, inicio y
    fin de la jornada (minutos desde medianoche), días laborables, «solo
    semana laboral», duración y recordatorio de un evento nuevo. Al leerla,
    cada campo inválido vuelve a su valor por omisión por separado
    (`sanitizeCalendarPrefs`); una jornada que acaba antes de empezar vuelve
    entera a 9:00–17:00.
- **Primer día de la semana:**
  - por omisión, el de la región del sistema (`navigator.languages[0]`), no
    el del idioma de la interfaz: solo el del sistema trae región, y una
    interfaz en inglés en Madrid sigue teniendo semanas de lunes;
  - se toma de `Intl.Locale` (`getWeekInfo()` o `weekInfo`), que tienen
    WebView2, WebKitGTK y JavaScriptCore; sin él, de una tabla con los datos
    de CLDR por región (domingo: EE. UU., Canadá, Japón, Brasil, Portugal…;
    sábado: Egipto, Irán, Golfo…; lunes: el resto, casi toda Europa). Un
    idioma sin región toma la probable (`de` → DE, `fa` → IR);
  - la persona puede fijar domingo, lunes o sábado; la opción regional dice
    qué día significa («Predeterminado regional (lunes)»);
  - lo usan las vistas de semana y mes (orden de columnas, cabeceras y rejilla
    de seis semanas), la ventana que se pide al núcleo, la etiqueta del
    periodo y los botones de días de una repetición semanal. Los campos de
    fecha del editor son los nativos del sistema (`<input type="date">`) y
    siguen la configuración regional del sistema, no esta preferencia.
- **Números de semana** (opcional, apagado por omisión): ISO 8601 cuando la
  semana empieza en lunes (la semana 1 contiene el primer jueves), sea cual
  sea la región; si empieza otro día, la regla de la región: la semana 1 es
  la primera con al menos `minimalDays` días del año, que en las regiones de
  domingo y sábado es la que contiene el 1 de enero. `Intl` ya no da
  `minimalDays` (se quitó de la propuesta), así que sale siempre de la tabla
  de CLDR (4 en casi toda Europa, 1 en el resto). Los días se cuentan sobre
  fechas, no sobre segundos, así que un cambio de hora no mueve una semana.
  Se muestran en la esquina de la vista de semana («W42» en inglés) y en una columna a
  la izquierda del mes.
- **Horario y días laborables:**
  - por omisión de 9:00 a 17:00, y laborables todos los días fuera del fin
    de semana de la región (lunes a viernes en Europa y EE. UU.; domingo a
    jueves en Egipto; en Irán, todos menos el viernes). Elegir días los fija
    y deja de seguir a la región; siempre queda al menos uno;
  - las vistas de día y semana sombrean las horas fuera de la jornada y los
    días no laborables enteros, y se abren desplazadas a media hora antes del
    inicio de la jornada;
  - el sombreado se calcula en horas de reloj de pared, igual que la posición
    de los eventos (`lib/calendarGrid`): un día de 23 o 25 horas sigue
    sombreado de 0:00 a 9:00 y de 17:00 a 24:00, y su jornada sigue durando
    ocho horas;
  - «Semana laboral» en la barra de la vista de semana (y en Ajustes) oculta
    los días no laborables; la etiqueta del periodo nombra los días que se
    ven. Una semana sin ningún laborable se muestra entera. La vista de día
    nunca se recorta.
- **Evento nuevo:** dura lo elegido (60 minutos por omisión) y lleva el
  recordatorio elegido (ninguno por omisión, como hasta ahora, para que nadie
  empiece a recibir avisos por una opción nueva). Hacer doble clic en un día
  del mes lo empieza al inicio de la jornada en vez de a las 9:00 fijas.
- **Móvil:** la agenda lee `calendar_week_start` al abrirse. Con un día
  fijado, la ventana de 14 días empieza en el primer día de la semana actual
  (páginas de semanas enteras, como en el escritorio); con «regional» sigue
  empezando hoy, porque el código común no tiene datos de semana por región.
  Si la preferencia cambia y la agenda estaba en la ventana de hoy, se
  recoloca; una ventana a la que se ha navegado no se mueve.

## Alternativas descartadas

- **Tomar la región del idioma de la interfaz:** `es`, `ca` o `en` no dicen
  dónde se vive; `en` sería EE. UU. y daría domingo a quien usa la interfaz
  en inglés en Europa.
- **Una sola fila con todo el calendario:** el móvil solo lee valores
  simples de `app.prefsGet` (`parseAppPrefsResponse` descarta objetos), y el
  primer día es lo único que necesita.
- **ISO 8601 para todos los números de semana:** en EE. UU., Japón o Brasil
  la semana del 1 de enero es la 1 y la cuentan en domingo; numerar con ISO
  una rejilla de domingo da semanas partidas.
- **Recordatorio de 15 minutos por omisión, como eM Client:** cambiaría lo
  que hace hoy cada evento nuevo sin que nadie lo pida.

## Pendiente (#100 sigue abierta)

- **Tiempo meteorológico:** eM Client lo muestra en el calendario, pero
  exige un servicio en línea (envía la ubicación a un tercero y puede
  necesitar una clave de API). No se implementa: queda fuera de alcance hasta
  que el propietario decida servicio, privacidad (qué ubicación se envía y
  cuándo) y si la clave la pone la persona.
- El primer día «regional» en el móvil (necesita datos de semana de la
  plataforma: `java.time.temporal.WeekFields` en Android, `Calendar.firstWeekday`
  en iOS).
- Sombreado y números de semana en el móvil, que hoy solo tiene agenda.
- Las agrupaciones del correo por «esta semana» (`lib/dateGroups.ts`) y los
  atajos «el lunes por la mañana» siguen en semanas de lunes.
- Comprobación nativa en Windows (WebView2) de la región del sistema y de
  los campos de fecha.
