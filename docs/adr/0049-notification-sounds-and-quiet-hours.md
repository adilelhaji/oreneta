# ADR-0049: Sonidos de notificación, no molestar y horas tranquilas

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-01 de la paridad con eM Client 10.4 (#114), «General →
  Notificaciones». Ya existían las notificaciones del sistema para el correo
  nuevo (que abren la conversación), el silencio por cuenta, ocultar y mostrar
  desde la bandeja y los contadores de no leídos opcionales. Faltaban los
  sonidos y un estado de silencio («no molestar»).

## Decisión

- **Sonidos:**
  - dos interruptores en Ajustes → Notificaciones: «Sonido para el correo
    nuevo» y «Sonido para los recordatorios» (de calendario y de tareas).
    Los dos empiezan **apagados**, así nadie oye nada nuevo por actualizar;
  - cuatro sonidos propios —campanilla, campana, pop y marimba— y un
    volumen de 0 a 100 (60 por omisión), común a los dos. Cada fila tiene
    «Reproducir» para oírlo con el volumen elegido; la prueba suena siempre,
    aunque esté en silencio;
  - los sonidos no son archivos: se sintetizan al momento con WebAudio
    (osciladores con una envolvente corta, menos de un segundo). No hay
    audio de terceros que licenciar ni nada que descargar, y la CSP de
    producción no tiene que permitir nada nuevo: un oscilador no es un
    recurso multimedia ni hace peticiones;
  - suenan en la vista, con los mismos eventos de los que el puente Go
    saca las notificaciones del sistema (`mail.newMessages`,
    `calendar.reminder` —también los del módulo común de recordatorios
    `pim/reminders.rs`— y `tasks.reminder`). El núcleo ya pone en cada
    evento de correo si la cuenta está silenciada (`muted`), y una cuenta
    silenciada tampoco suena.
- **No molestar:**
  - se activa «durante 1 hora», «hasta mañana» (mañana a las 8:00, hora
    local) o «hasta que lo desactive», desde Ajustes, desde el menú «Más»
    de la barra lateral y desde la bandeja del sistema (una casilla «No
    molestar» que lo activa hasta desactivarlo, o lo reanuda si ya está);
  - mientras dura: no hay ventanas emergentes del sistema, tampoco el aviso
    «correo nuevo» dentro de la app, y no suena nada. Los contadores de no
    leídos, el icono de la bandeja y las listas siguen actualizándose;
  - los recordatorios de calendario y tareas siguen mostrándose (y sonando,
    si su sonido está activo), porque llegan a una hora concreta; una
    casilla, «Mostrar los recordatorios aunque esté en silencio» (activada
    por omisión, como en eM Client), permite callarlos también;
  - cuando está en silencio, la barra lateral muestra un indicador (campana
    tachada) que dice hasta cuándo, y un clic en él lo reanuda. El menú
    «Más» y la fila de Ajustes ofrecen «Reanudar» también.
- **Horas tranquilas:**
  - un horario diario opcional: hora de inicio, hora de fin y días de la
    semana (todos por omisión, 22:00–07:00);
  - las horas son de reloj local: 22:00 es 22:00 en la pared, sea cual sea
    el desfase ese día. Las fechas se construyen con el constructor local
    de `Date`, que ya cae en el instante correcto en los cambios de hora
    (una hora que no existe, como 02:30 el día que se adelanta, pasa a
    03:30; una noche de 22:00 a 07:00 dura ocho horas ese día y diez el que
    se atrasa);
  - un fin anterior o igual al inicio cruza la medianoche: el periodo acaba
    al día siguiente. Inicio igual a fin es el día entero. El día marcado es
    el día en que **empieza** el periodo: con solo laborables, la noche del
    viernes al sábado es tranquila y la del domingo al lunes no;
  - «Reanudar» durante un periodo programado lo salta hasta su final; el
    siguiente se aplica normalmente.
- **Una sola decisión, dos sitios que la aplican:**
  - las reglas están en una función pura en la vista
    (`lib/quietHours.ts`: `quietStateAt`, `shouldShowNotification`,
    `soundFor`, `quietIntervals`), que recibe `now` y se prueba en
    cualquier instante;
  - el puente Go, que es quien muestra las notificaciones del sistema, no
    repite el horario: recibe por `notify.setQuiet` los intervalos
    tranquilos de los próximos ocho días (milisegundos, `[inicio, fin)`),
    si hay una pausa sin fin, si los recordatorios pasan y si ahora está en
    silencio (para la casilla de la bandeja). Solo comprueba si «ahora»
    cae dentro. La vista se los manda al cambiar algo y cada hora, así el
    puente sigue decidiendo bien aunque la ventana, oculta en la bandeja,
    tenga los temporizadores ralentizados;
  - el silencio por cuenta se sigue aplicando antes, como siempre.
- **Se guarda** como una fila de ajustes (`notification_prefs`, el patrón
  `DB_KEY`): los sonidos, el volumen, la pausa (con su fin, o sin fin), el
  horario, el salto por «Reanudar» y la casilla de recordatorios. Un campo
  inválido vuelve a su valor por omisión sin tocar los demás. Una pausa
  «hasta que lo desactive» sobrevive al reinicio.

## Alternativas descartadas

- **Incluir archivos de audio (WAV/OGG):** habría que revisar licencias y
  añadirían peso; unos pocos tonos sintetizados bastan para avisos cortos.
- **Reproducir el sonido desde Go con la API de cada sistema:** tres
  implementaciones (y una dependencia de audio en Linux) para algo que el
  motor web ya hace igual en todas partes.
- **Que la vista mande solo «en silencio sí/no» al puente:** dependería de
  que la ventana despierte justo en el cambio; con la ventana en la bandeja
  sus temporizadores pueden retrasarse y una notificación se colaría.
- **Repetir el horario en Go:** dos implementaciones de la misma regla, con
  cambios de hora y medianoche, que podrían discrepar.
- **«Hasta mañana» como medianoche:** activarlo a las 23:30 duraría media
  hora. Se usa mañana a las 8:00 y el menú lo dice.

## Pendiente

- Usar el modo «no molestar» o «concentración» del propio sistema (Windows,
  macOS, GNOME) para entrar y salir solos.
- Un sonido por cuenta o por carpeta, y sonidos propios elegidos por la
  persona.
- La casilla de la bandeja se actualiza cuando la vista manda el estado; con
  la ventana muy dormida puede ir con retraso, aunque las notificaciones sí
  se callan a tiempo.
- Prueba nativa en Windows (sonido y bandeja) para pasar la fila a
  verificada.
