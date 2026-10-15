# ADR-0056: Recordatorios tras una suspensión y un cambio de zona horaria

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #209 en la opción más prudente); pendiente de revisión del
  propietario al final del plan.
- Fecha: 2026-10-15.
- Alcance: #209 (fila SET-29 del libro de paridad, padre #100), sobre los
  recordatorios comunes de ADR-0045 (`pim::reminders`). Diseño:
  [recordatorios del calendario](../design/calendar-reminders.md).

## Contexto

Un recordatorio se daba una vez, volvía a darse si el evento se movía y
sobrevivía a un reinicio. Pero:

- solo se daba si el evento aún no había empezado. Si el equipo dormía a la
  hora del aviso y despertaba con la reunión ya empezada, se perdía;
- el vigilante del escritorio miraba cada minuto con un temporizador del
  reloj monotónico, que en algunos sistemas se para durante la suspensión;
- el aviso de un evento de día completo contaba hacia atrás desde la
  medianoche UTC de su fecha, no desde la medianoche local: en Madrid, «el
  día antes a las 18:00» sonaba a las 20:00, y no seguía al lector a otra zona;
- la notificación de Go mostraba la hora en la zona con que arrancó la
  aplicación.

## Decisión

- **Cada mirada queda anotada por cuenta** (`meta`,
  `reminders.look:<cuenta>`): cuándo fue y el desfase UTC de la zona en ese
  momento. Se escribe después de anotar los avisos dados; un corte entre
  ambos solo hace mirar otra vez el mismo hueco, y lo anotado impide repetir.
  Se borra con la cuenta (ADR-0011).
- **Qué da una mirada**: cada aviso no anotado cuya hora ha llegado, una sola
  vez, si sigue sirviendo:
  - su evento aún no ha empezado (a tiempo, o sincronizado tarde), o
  - no había vencido en la mirada anterior y su evento no ha terminado: venció
    mientras nadie miraba (equipo dormido, aplicación cerrada) o un cambio de
    zona lo adelantó.
  Un aviso cuyo evento ya terminó antes de mirar no se da.
- **Límites del hueco**: un reloj atrasado no abre hueco (la mirada anterior
  cuenta como «ahora»); un hueco se mira como mucho 14 días hacia atrás, la
  vida del registro de avisos dados. Sin mirada anterior (primera vez, o tras
  actualizar) solo se da lo que aún no ha empezado, como antes.
- **Cuentas en pausa o silenciadas**: no se avisa y su mirada avanza igual.
  Lo que vence mientras el lector pidió no oír nada no se guarda para después.
- **Al despertar**: `system.resumed` hace mirar en el acto, sin esperar al
  siguiente minuto. La hora es siempre la del reloj de pared; el temporizador
  ya no acumula ticks perdidos (`MissedTickBehavior::Delay`).
- **Zonas, según el modelo del calendario**:
  - evento con hora (con zona o en UTC): un instante; su aviso no se mueve;
  - evento de día completo: una fecha (guardada como su medianoche UTC); el
    aviso cuenta desde la medianoche local en la zona del equipo en cada
    mirada. Un día sin medianoche (cambio de hora a las 00:00) empieza cuando
    empieza el reloj;
  - hora flotante (CalDAV, suscripciones): se lee en la zona del equipo al
    leer el calendario (`subscription`). Tras un cambio de zona, el vigilante
    vuelve a leer las cuentas con calendarios CalDAV o suscritos, y su aviso
    sigue esa lectura como el de un evento movido.
- **Cambio de zona**: se detecta comparando el desfase que la zona actual da
  al instante de la mirada anterior con el que se anotó. Un cambio de horario
  de verano no cuenta: la misma zona da el mismo desfase al mismo instante.
- **Hora en la notificación**: cada `calendar.reminder` lleva `local_time`
  («HH:MM» del inicio en la zona actual; `null` en un día completo). Go la
  muestra; sin ella, usa su propio reloj como antes.

## Consecuencias

- Tras dormir durante el aviso de una reunión aún en curso, el aviso llega al
  despertar, una vez.
- Un evento flotante cuyo aviso ya se dio y que, por ir hacia el oeste, queda
  más tarde, se avisa otra vez antes de su nueva hora (como un evento movido).
- Si la nueva lectura de un evento flotante lo sitúa en un momento ya
  empezado, su aviso no se da tarde (como un evento movido al pasado). Hasta
  esa lectura, sin conexión, el evento flotante conserva el instante anterior.
- No hay migración de esquema ni cambio en el modelo `Event`.

## Alternativas descartadas

- **Guardar la hora de pared de los eventos flotantes en una columna nueva**
  (borrador #198): exacto antes de releer, pero exige migración de esquema y
  tocar la construcción de `Event` en todos los proveedores, para un caso raro
  (CalDAV casi siempre escribe `TZID`). Releer ya es lo que el modelo define.
- **Agrupar los avisos perdidos en un aviso nuevo y contar los de eventos
  terminados** (borrador #198): añade eventos, textos e interfaz. Un aviso de
  un evento terminado no sirve para nada.
- **Dar también los avisos de eventos terminados**: tras una noche dormido
  llegaría una ráfaga de avisos inútiles.
- **Recordar la mirada anterior solo en memoria**: no cubre la aplicación
  cerrada ni el móvil, que mira en procesos separados.
- **Detectar el cambio de zona por su nombre IANA**: no siempre está
  disponible y no da la zona anterior para calcular; el desfase sí.
