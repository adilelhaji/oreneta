# ADR-0043: Proponer otra hora y coincidencias con la agenda propia

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-12.
- Alcance: lo que ADR-0019 dejó pendiente de #102 (contrapropuesta y
  disponibilidad).

## Decisión

- **Proponer otra hora (asistente):**
  - en la tarjeta de una invitación por correo, «Proponer otra hora» abre un
    formulario con inicio, fin y una nota opcional; nada sale hasta pulsar
    «Enviar propuesta»;
  - se envía un iTIP `COUNTER` (RFC 5546 §3.2.7) solo al organizador, por la
    misma ruta que las respuestas (ADR-0019): un mensaje normal con adjunto
    `text/calendar; method=COUNTER`, registrado como intento de envío;
  - el objeto lleva el mismo UID y la misma SEQUENCE de la invitación (una
    propuesta no crea versión), DTSTAMP, el ORGANIZER tal como llegó, solo
    el ATTENDEE propio, el inicio y el fin propuestos (en UTC, o como
    `VALUE=DATE` si la invitación es de día entero), el SUMMARY y el COMMENT
    escapado;
  - se rechaza, sin enviar nada, si la invitación es antigua (SEQUENCE menor
    que la ya contestada), si la reunión está cancelada (CANCEL, STATUS o
    cancelación aplicada), si el fin no es posterior al inicio, si la cuenta
    es la organizadora o si es una serie entera sin RECURRENCE-ID;
  - el calendario propio no cambia: decide el organizador.
- **Recibir una propuesta (organizador):**
  - la tarjeta dice quién propone qué hora y su nota;
  - si la cuenta organiza un evento guardado aquí con ese UID (calendario
    propio, no suscripción, con ORGANIZER igual a la cuenta), ofrece
    «Abrir en el editor» y «Rechazar la propuesta»; si no, solo informa;
  - una propuesta para una versión anterior aparece como antigua y sin
    botones. La SEQUENCE actual se lee del servidor si el evento está en
    CalDAV. En un calendario local no se guarda y no se puede comparar.
- **Aceptar una propuesta:** «Abrir en el editor» abre el evento propio con
  la hora propuesta. Guardar pasa por la actualización de siempre
  (`calendar.update`) y no hay una ruta nueva de envío.
  - En calendarios locales y CalDAV, guardar no avisa a los asistentes; la
    tarjeta y el editor lo dicen.
  - El editor ya no pregunta «¿Avisar a los asistentes?» en esos
    calendarios: antes lo preguntaba y el núcleo no enviaba nada.
- **Rechazar una propuesta:** iTIP `DECLINECOUNTER` (§3.2.8) solo al
  asistente que propuso, con el mismo UID y SEQUENCE, el ORGANIZER, ese
  ATTENDEE, DTSTAMP y la nota opcional. La reunión queda como estaba.
- **Rechazo recibido (asistente):** la tarjeta dice «El organizador rechazó
  la hora que propusiste», con su nota, y nada más.
- **Coincidencias con la agenda propia:**
  - el editor de eventos, la tarjeta de una invitación, el formulario de
    propuesta y la tarjeta de una propuesta dicen qué eventos propios se
    solapan con esa hora: «Coincide con: …», hasta tres asuntos y «y N
    más»;
  - es una consulta local a `calendar_events` de todas las cuentas, sin
    red, y no cuenta lo cancelado, lo libre o transparente (`free_busy`
    `free`), lo que la persona rechazó ni el propio evento;
  - tampoco cuentan las suscripciones: son calendarios publicados por
    otros, como los festivos;
  - un evento de día entero cuenta solo si la hora propuesta toca su día
    donde está la persona;
  - un evento CalDAV o importado con `TRANSP:TRANSPARENT` se guarda ahora
    como libre.
- **Exchange y Google:** sus cuentas tratan las propuestas en su propio
  calendario; la tarjeta lo indica, como con las invitaciones.

## Alternativas descartadas

- **Aplicar la propuesta al calendario directamente desde la tarjeta:**
  cambiaría la hora sin revisar el resto del evento. Además, parecería que
  los asistentes quedan avisados, y no es así.
- **Enviar desde aquí la actualización a todos los asistentes al aceptar:**
  no existe una ruta de envío de actualizaciones del organizador para
  calendarios locales y CalDAV, y no se inventa una en esta entrega.
- **Guardar la SEQUENCE en `calendar_events`:** sería una columna más que
  sincronizar en todos los proveedores. Leerla del servidor CalDAV cuando
  hace falta basta.
- **Disponibilidad de los asistentes desde los servidores:** bloqueada.
  - Google necesita los registros OAuth propios.
  - La bandeja de salida de CalDAV scheduling no existe en Radicale, que es
    el servidor de pruebas.
  - `GetUserAvailability` de EWS necesita un servidor Exchange real.

## Pendiente

- Avisar a los asistentes al guardar como organizador en calendarios
  locales y CalDAV (enviar un REQUEST actualizado).
- Disponibilidad de otras personas desde Google, CalDAV y EWS (bloqueada,
  ver arriba).
- Verificación N5 con Outlook, Gmail y Apple Calendar.
