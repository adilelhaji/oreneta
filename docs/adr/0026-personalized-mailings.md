# ADR-0026: Envíos personalizados con resultado por destinatario

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12. Cubre la puerta de #90 (modelo
  de persistencia del envío masivo).
- Fecha: 2026-10-12.
- Alcance: #90.

## Decisión

- **Un mensaje por destinatario,** dirigido solo a esa persona: sin Para
  compartido, sin CCO, sin datos de nadie en el mensaje de otro.
- **Lo revisado es lo enviado:**
  - el núcleo genera cada mensaje (`merge::preview`); la vista previa
    muestra esos mensajes;
  - al empezar, el núcleo los genera otra vez con los mismos datos y solo
    guarda el envío si no hay problemas y el número coincide con lo
    revisado.
- **Problemas que impiden enviar:**
  - dirección no válida;
  - destinatario repetido (sin distinguir mayúsculas);
  - marcador desconocido;
  - un valor que falta (se queda escrito tal cual en la vista previa);
  - sin destinatarios o sin asunto;
  - más de 500 destinatarios.
- **Lista de destinatarios:** una línea por persona, o una tabla cuya
  primera línea nombra sus columnas (una se llama `email`). Las columnas son
  marcadores.
- **Persistencia:**
  - `merge_batches` guarda estado y motivo; `merge_items` guarda cada
    mensaje ya generado, su Message-ID propio, su estado y su error;
  - cada mensaje es un intento de #29 con su Message-ID como id;
  - al borrar una cuenta se borran sus envíos.
- **Envío:**
  - uno a la vez, con 3 s de separación por defecto;
  - cada mensaje queda aceptado, rechazado, incierto o cancelado;
  - un rechazo temporal del servidor (4xx, límite de envío) pausa el envío y
    deja el mensaje pendiente;
  - un mensaje incierto nunca se repite solo;
  - un rechazado solo se reintenta si la persona lo pide.
- **Detener, reinicio y reanudación:**
  - detener marca como cancelado lo que falta; lo que ya salió sigue
    contado;
  - al reiniciar, el envío queda en pausa y el mensaje en curso se resuelve
    por su intento (aceptado, incierto o pendiente si nunca empezó);
  - seguir es decisión de la persona.
- **Pruebas:** usan un servidor simulado o direcciones de ejemplo; nunca
  correo real.

## Pendiente

- Cuerpo en HTML y adjuntos.
- Separación configurable en la interfaz.
- Guardar el envío entero como borrador.
