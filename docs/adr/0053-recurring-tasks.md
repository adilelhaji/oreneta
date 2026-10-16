# ADR-0053: Tareas que se repiten

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: lo que ADR-0013 y ADR-0039 dejaron fuera de #103 (fila SET-20
  del registro de paridad con eM Client 10.4, «Tasks»): crear y editar la
  repetición de una tarea, y completar una ocurrencia sin perder la serie,
  en listas locales y en listas CalDAV.

## Decisión

- **Un solo modelo de repetición para eventos y tareas:**
  - la regla es `calendar::Recurrence` (la del editor de eventos), con dos
    campos nuevos: `month_week` (el enésimo día de la semana del mes, 1–4 o
    -1 para «el último») y `month_day` (el día del mes cuando no es el de la
    fecha de vencimiento);
  - el editor de la repetición es uno (`RepeatFields`), compartido por el
    editor de eventos y el de tareas. El de tareas ofrece además «el
    segundo martes» / «el último viernes» junto a «el día 13»; el de
    eventos todavía no, porque Exchange y Google no lo escriben aún desde
    aquí;
  - el texto de la regla es un valor `RRULE` (RFC 5545), igual en local y
    en CalDAV: `calendar::recurrence` lo lee, lo escribe y calcula la
    siguiente fecha.
- **Qué reglas se escriben:** diaria, semanal (en uno o varios días),
  mensual (un día del mes o el enésimo día de la semana), anual; cada N; sin
  fin, N veces (`COUNT`) o hasta una fecha (`UNTIL`, inclusiva).
  - Al escribirla se explicita todo lo que dependería del inicio:
    `BYDAY` en la semanal, `BYMONTHDAY` o `BYDAY=2TU` en la mensual,
    `BYMONTH` en la anual. Así, mover el inicio a la siguiente ocurrencia
    nunca cambia los días en que cae.
  - `UNTIL` va como fecha si la tarea vence en un día sin hora, y como el
    final de ese día aquí, en UTC, si tiene hora (debe tener la forma del
    inicio).
  - Al leerlo (aclarado el 2026-10-16, #221), un `UNTIL` en UTC es la
    fecha en que cae ese instante en la zona de este ordenador, no en UTC:
    RFC 5545 corta la serie en ese instante, y una ocurrencia de esa fecha
    a una hora anterior es de la serie. Es exacto cuando `UNTIL` es la
    última ocurrencia o el final de su día, que es lo que escriben Oreneta
    y los clientes habituales; con otro `UNTIL` (mediodía UTC, por ejemplo)
    una tarea con hora posterior a la de `UNTIL` ese día tendría una
    ocurrencia más que en la RFC, porque la regla guarda una fecha y no un
    instante. En UTC+12 o más, el mediodía UTC del 31 de diciembre ya es el
    1 de enero; CI pasa las pruebas del calendario también con
    `TZ=Pacific/Auckland`.
  - «Diaria en lunes a viernes», como la escribe Thunderbird, se lee como
    semanal en esos días.
- **Fin de mes:** el 31 de un mes de 30 días es el 30, y el 29 de febrero
  de un año no bisiesto, el 28; el mes siguiente vuelve al 31. Es lo que
  hacen Outlook y eM Client. RFC 5545 omite esos meses; una tarea «el 31»
  que se saltara medio año sería una tarea olvidada. Como la regla lleva
  `BYMONTHDAY=31`, otro cliente que siga la RFC calcula otro día para ese
  mes, pero el vencimiento escrito (`DUE`) es el que manda.
- **Horas y cambio de horario:** la siguiente ocurrencia conserva la hora
  de reloj (una tarea a las 09:00 sigue a las 09:00 tras el cambio). Una
  hora que el cambio se salta (02:30 la noche en que se adelanta) pasa a la
  primera que existe. Se calcula con la zona de este ordenador.
- **Una tarea que se repite necesita fecha de vencimiento** (la regla
  cuenta desde ella); elegir una repetición sin fecha pone hoy. Una tarea
  ligada a una conversación no se repite.
- **Completar una ocurrencia** (lo que hace la casilla, tras preguntar):
  - se guarda una copia completada de la tarea, sin regla, con el
    vencimiento de esa ocurrencia: el registro de lo hecho;
  - la tarea pasa a la siguiente ocurrencia: vencimiento nuevo, el
    recordatorio a la misma distancia (y vuelve a sonar), y la regla con lo
    que queda (`COUNT` baja en uno);
  - la siguiente ocurrencia es la de después del vencimiento, aunque ya
    haya pasado; no se saltan ocurrencias atrasadas;
  - si era la última (fin por fecha o por número), la tarea se completa sin
    más y no se hace copia.
- **«Dejar de repetir»:** quita la regla y completa la tarea. Reabierta, ya
  no se repite. Las copias de ocurrencias anteriores se quedan.
- **En una lista CalDAV (ADR-0039):**
  - se elige mover la tarea maestra y guardar la ocurrencia hecha como
    tarea aparte, como Apple Reminders; tasks.org (DAVx⁵) mueve la tarea
    igual, sin copia. Se escriben `DUE` y `DTSTART` (movido los mismos días,
    en su forma: fecha, hora con `TZID` o UTC; se añade si falta, porque la
    regla cuenta desde él) y `RRULE`; `STATUS` sigue `NEEDS-ACTION`. La
    copia es un objeto nuevo con `STATUS:COMPLETED`. Ambos van con la
    sincronización normal, la copia con `If-None-Match: *` y la maestra con
    `If-Match`;
  - se descarta la otra práctica, la de Thunderbird: una excepción
    `RECURRENCE-ID` completada por ocurrencia. Muchos clientes (tasks.org,
    Apple Reminders, la app Tasks de Nextcloud) no la interpretan: verían
    la serie atrasada para siempre, y el objeto crece sin límite. Radicale
    y Nextcloud solo guardan el objeto; con la maestra movida y la regla
    intacta, cualquier cliente que siga la RFC ve la serie bien;
  - la serie nunca se pierde: la regla y el `UID` siguen en el mismo
    objeto, y lo demás que tenga (propiedades X-, categorías, relaciones,
    alarmas) se conserva línea a línea, como en ADR-0039;
  - un recordatorio de una tarea que se repite se escribe relativo al
    vencimiento (`TRIGGER;RELATED=END:-PT1H`), que en una serie suena en
    cada ocurrencia. Si la alarma ya era relativa y la distancia no cambia,
    no se toca;
  - una tarea que se repite de una forma que aquí no se escribe sigue
    siendo de solo lectura, con el aviso de siempre: `RDATE`, `EXDATE`,
    ocurrencias cambiadas (`RECURRENCE-ID`), varias `RRULE`, partes como
    `BYSETPOS` o `BYHOUR`, una anual en otro mes que el del vencimiento, o
    una regla sin `DUE`. Se ve y se borra, pero no se cambia: cambiarla
    mal sería peor.
- **Avisos:** la lista muestra un icono de repetición y la regla en breve
  («Cada semana», «Cada 3 días»). Al completar una ocurrencia se dice cuándo
  vence la siguiente.
- **Esquema 61:** columna `tasks.rrule` (valor `RRULE`, vacío si no se
  repite). La migración vuelve a leer las tareas CalDAV marcadas como de
  solo lectura desde la copia guardada, para que las que ahora se pueden
  editar lo sean sin esperar un cambio en el servidor.

## Fuera de alcance

- «Regenerar la tarea N días después de completarla» (Outlook): no hay
  forma estándar de guardarlo en un VTODO; queda para otra entrega.
- Tareas de Google Tasks, Microsoft To Do (Graph) y Exchange (EWS): siguen
  sin proveedor; la fila SET-20 lo dice. Exchange ya lo tiene (ADR-0058).
- «Saltar esta ocurrencia» sin completarla.
- El enésimo día de la semana en eventos (falta escribirlo en Exchange y
  Google).

## Pruebas

- `calendar/recurrence/tests.rs`: siguiente fecha diaria, semanal en
  varios días y cada N, el 31 en meses cortos (30, 28, 29), el 29 de
  febrero, el enésimo y el último día de la semana, fin por número y por
  fecha, hora de reloj a través del cambio de horario (Madrid y Los
  Ángeles, también una hora inexistente), lectura y escritura de `RRULE` y
  reglas rechazadas.
- `task_sync/vtodo/tests.rs`: una regla de otro cliente se lee explicitada;
  editar otra cosa no la toca; pasar a la siguiente ocurrencia escribe
  `DUE`, `DTSTART`, `RRULE` y conserva lo desconocido; las repeticiones que
  no se escriben siguen bloqueadas.
- `task_sync/tests.rs`: completar contra un servidor de prueba (maestra
  movida, copia completada nueva, recordatorio movido, sin conflicto en la
  siguiente lectura, fin por número), dejar de repetir, una tarea nueva
  con regla y la migración.
- `store/task_lists/tests.rs`: lo mismo en una lista local.
- Integración con Radicale (`integration_caldav_tasks_test.go`): completar
  una ocurrencia y leerla de vuelta del servidor real.
- Frontend: `RecurringTasks.test.tsx` (editor, indicador y elección al
  completar). Todo con `TZ=Asia/Tokyo` y `TZ=America/Los_Angeles` además de
  la zona del equipo.
