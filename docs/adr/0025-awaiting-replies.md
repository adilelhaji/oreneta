# ADR-0025: Esperando respuesta

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12. Cubre la puerta de #45
  (estados, evidencia de identidad, política de recordatorio y
  persistencia).
- Fecha: 2026-10-12.
- Alcance: #45.

## Decisión

- **Qué se espera:**
  - el último mensaje que la persona envió en una conversación, desde su
    dirección o un alias;
  - se guarda por Message-ID normalizado, así que sobrevive a movimientos,
    descargas nuevas y reinicios.
- **Estados guardados:** `waiting`, `done` y `cancelled`, que son decisiones
  de la persona.
- **Estados calculados al leer, nunca guardados:** `answered`, `possible` y
  `waiting`.
- **Evidencia, sin mirar nunca el asunto:**
  - un mensaje posterior cuyo `In-Reply-To` nombra el enviado (`direct`), o
    que pertenece a su conversación (`conversation`);
  - si viene de alguien a quien se envió, es una respuesta;
  - si viene de otra persona, o de una dirección automática (no-reply,
    rebotes), es una respuesta posible, y la persona decide;
  - las direcciones propias y los alias nunca responden;
  - un mensaje anterior al enviado tampoco.
- **Correcciones:**
  - «es la respuesta» fija ese mensaje;
  - «no es una respuesta» lo descarta para siempre;
  - ninguna se pierde al volver a sincronizar.
- **Recordatorio:**
  - opcional, en segundos UTC; por defecto a las 9:00 locales del día
    elegido;
  - se avisa una sola vez y solo dentro de la app;
  - si ya llegó la respuesta, no se avisa;
  - nunca se envía nada a nadie.
- **Cuentas:** al borrar una cuenta se borran sus registros (ADR-0011).

## Pendiente

- Elegir la fecha del recordatorio en el propio menú; hoy son 3 días.
- Abrir la conversación desde la lista.
- Mostrar la marca en la fila de la conversación.
