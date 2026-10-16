# ADR-0056: Recordatorios tras una suspensión y un cambio de zona horaria

- Estado: aceptada por delegación (el propietario delegó las decisiones de
  diseño de #209 y #225 en la opción más prudente); pendiente de revisión
  del propietario al final del plan. El punto que quedó «a confirmar» (los
  avisos de eventos terminados) lo decidió el propietario: se muestran
  (#225, ver «Ampliación del 2026-10-16»).
- Fecha: 2026-10-15; ampliada el 2026-10-16 (#225).
- Alcance: #209 y #225 (fila SET-29 del libro de paridad, padre #100), sobre los
  recordatorios comunes de ADR-0045 (`pim::reminders`). Diseño:
  [recordatorios del calendario](../design/calendar-reminders.md).

## Contexto

Un recordatorio se daba una vez, volvía a darse si el evento se movía y
sobrevivía a un reinicio. Pero:

- solo se daba si el evento aún no había empezado. Si el equipo dormía a la
  hora del aviso y despertaba con la reunión ya empezada, se perdía, y un
  aviso «al empezar» (0 minutos) no se daba nunca;
- el vigilante del escritorio miraba cada minuto con un temporizador del
  reloj monotónico, que en algunos sistemas se para durante la suspensión;
- el aviso de un evento de día completo contaba hacia atrás desde la
  medianoche UTC de su fecha, no desde la medianoche local: en Madrid, «el
  día antes a las 18:00» sonaba a las 20:00, y no seguía al lector a otra zona;
- la notificación de Go mostraba la hora en la zona con que arrancó la
  aplicación, y un aviso dado tarde parecía uno a tiempo.

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
- **Un aviso cuyo evento terminó antes de mirar** no se daba (#209); desde
  #225 se da en un único aviso agrupado de avisos perdidos, por decisión del
  propietario (ver «Ampliación del 2026-10-16»).
- **Un aviso «al empezar»** (0 minutos) se da en la primera mirada desde el
  inicio, mientras el evento sigue: antes no se daba nunca (corrección). Un
  evento sin duración cuenta como en curso durante su primer minuto, así que
  su aviso «al empezar» lo da la mirada de ese minuto.
- **Límites del hueco**: un reloj atrasado no abre hueco (la mirada anterior
  cuenta como «ahora»); un hueco se mira como mucho 14 días hacia atrás, la
  vida del registro de avisos dados. Sin mirada anterior (primera vez, o tras
  actualizar) solo se da lo que aún no ha empezado, como antes.
- **Si el almacén falla** al buscar lo vencido o al anotar un aviso, ese
  aviso no se da y la mirada no se anota: la siguiente vuelve a mirar el
  mismo hueco y lo da entonces, una vez.
- **Cuentas en pausa o silenciadas**: no se avisa y su mirada avanza igual.
  Lo que vence entretanto no se da después como perdido; un aviso vencido
  durante la pausa cuyo evento aún no ha empezado sí se da al reanudar, por
  la regla de siempre.
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
    leer el calendario (`subscription`). Tras un cambio de zona se anota
    (`reminders.reread:<cuenta>`) que hay que releer las cuentas con
    calendarios CalDAV o suscritos visibles; el escritorio pide esa lectura
    en el acto y de nuevo cada 15 minutos, con la misma ventana (así no se
    lanzan dos a la vez), hasta que cada uno de esos calendarios se ha leído
    después del cambio. Una cuenta silenciada se relee igual; una en pausa,
    al reanudarla. El aviso sigue esa lectura como el de un evento movido.
- **Cambio de zona**: se detecta comparando el desfase que la zona actual da
  al instante de la mirada anterior con el que se anotó. Un cambio de horario
  de verano no cuenta: la misma zona da el mismo desfase al mismo instante.
  Sin cambio de zona, cuándo vencía un aviso en la mirada anterior se calcula
  con la zona actual (con sus reglas de horario de verano); con cambio, con
  el desfase anotado, que es todo lo que se sabe de la zona anterior.
- **Qué dice el aviso**: cada `calendar.reminder` lleva, además de lo de
  siempre, `local_time` («HH:MM» del inicio en la zona actual; `null` en un
  día completo), `started` (si el evento ya había empezado) y `local_date`
  («AAAA-MM-DD» si no es hoy; `null` si lo es). Go muestra la fecha delante
  de la hora cuando no es hoy y, si ya empezó, «Empezó a las {time}»
  (`notify.reminderStarted`, traducido). Sin esos campos usa su propio reloj
  como antes.
- **Móvil**: `take_due` deja fuera la lista de relecturas; el móvil relee sus
  calendarios en su refresco de cada 15 minutos (ADR-0045), que es también
  lo que borra la relectura pendiente. En Android, `chrono::Local` podría
  dar UTC si el sistema no le dice la zona; queda para la prueba nativa.

## Consecuencias

- Tras dormir durante el aviso de una reunión aún en curso, el aviso llega al
  despertar, una vez, diciendo que ya empezó.
- Los avisos de día completo cambian de hora respecto a antes: suenan antes
  al este de UTC (Europa, Asia) y después al oeste (América), ahora a la hora
  local que se pidió.
- Un evento flotante cuyo aviso ya se dio y que, por ir hacia el oeste, queda
  más tarde, se avisa otra vez antes de su nueva hora (como un evento movido).
- Si la nueva lectura de un evento flotante lo sitúa en un momento ya
  empezado, su aviso no se da tarde (como un evento movido al pasado). Hasta
  esa lectura, sin conexión, el evento flotante conserva el instante anterior.
- No hay migración de esquema ni cambio en el modelo `Event`. Hay un texto
  nuevo (`notify.reminderStarted`) en los 19 idiomas.

## Alternativas descartadas

- **Guardar la hora de pared de los eventos flotantes en una columna nueva**
  (borrador #198): exacto antes de releer, pero exige migración de esquema y
  tocar la construcción de `Event` en todos los proveedores, para un caso raro
  (CalDAV casi siempre escribe `TZID`). Releer ya es lo que el modelo define.
- **Agrupar los avisos perdidos en un aviso nuevo y contar los de eventos
  terminados** (borrador #198): descartada en #209 por añadir eventos, textos
  e interfaz; adoptada en #225 cuando el propietario decidió verlos.
- **Dar también los avisos de eventos terminados, uno a uno**: tras una noche
  dormido llegaría una ráfaga de avisos inútiles.

## Ampliación del 2026-10-16: avisos perdidos (#225)

El propietario decidió que los avisos de eventos que terminaron mientras
nadie miraba se muestren, como en eM Client y Outlook, sin ráfaga.

- **Qué es un aviso perdido**: uno no anotado que venció después de la mirada
  anterior (la misma regla y el mismo límite de 14 días que arriba) y cuyo
  evento ya terminó en el momento de mirar. Sin mirada anterior no hay
  perdidos: no se sabe qué hueco hubo.
- **Uno solo**: todos los perdidos de una mirada, de todas las cuentas, van
  en un único evento `calendar.missedReminders` con `count`, `day` (la fecha
  del primero, «AAAA-MM-DD» en la zona actual) y `reminders` (cada uno como
  un `calendar.reminder`, en el orden en que empezaron sus eventos). Go lo
  muestra como una notificación: el título dice cuántos
  (`notify.missedReminders`, en los 19 idiomas) y el cuerpo, uno por línea,
  cuándo y qué, hasta 5 y «…» si hay más. Las horas de silencio la retienen
  como a cualquier aviso; suena como un aviso.
- **Al pulsarla** se abre el calendario en vista de día en el primer día
  perdido (`calendar:AAAA-MM-DD` como destino del clic).
- **Una vez**: cada perdido se anota como dado antes de devolverlo, igual que
  los demás; ni otra mirada, ni un reinicio, ni un despertar lo repiten. Si
  no se puede anotar, no se muestra y la mirada no se anota: sale en el
  aviso agrupado de la mirada siguiente.
- **Lo que sigue en curso** no cambia: se da solo, diciendo «Empezó a las…».
- **Cuentas en pausa o silenciadas**: no muestran nada, tampoco luego (su
  mirada avanza igual).
- **Móvil**: aún no tiene aviso agrupado. `take_due` (`pim.refresh`) deja los
  perdidos sin anotar y sin dar, como antes de #225, así que la respuesta y
  `PimRefresh.kt` no cambian. Darlos en el móvil necesita un aviso agrupado
  en Android e iOS y queda pendiente.
- **Recordar la mirada anterior solo en memoria**: no cubre la aplicación
  cerrada ni el móvil, que mira en procesos separados.
- **Pedir la relectura una sola vez**: el escritorio no relee sus calendarios
  por su cuenta (ADR-0045); una lectura fallida dejaría la hora flotante en la
  zona anterior hasta que alguien abriera el calendario.
- **Detectar el cambio de zona por su nombre IANA**: no siempre está
  disponible y no da la zona anterior para calcular; el desfase sí.
