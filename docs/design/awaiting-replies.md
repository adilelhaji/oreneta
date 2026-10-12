# Esperando respuesta (#45, ADR-0025)

## Uso

En el menú de una conversación en la que se ha escrito:
- **Esperar respuesta (recordatorio en 3 días)** marca el último mensaje
  enviado;
- **Esperando respuestas…** abre la lista.

La lista dice, para cada mensaje:
- si tiene respuesta y cómo se sabe;
- qué respuestas son posibles y por qué hay duda, con «Es la respuesta» o
  «No es una respuesta»;
- si ya pasó su recordatorio.

«Hecho» y «Dejar de esperar» lo cierran.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `awaiting/tests.rs` | Respuesta directa de un destinatario en copia; respuesta en la conversación sin `In-Reply-To`; el asunto solo nunca responde; alias propios y correo anterior excluidos; respuestas automáticas y de desconocidos como posibles, con decisión de la persona; movimiento, nueva descarga y reinicio; recordatorio una sola vez y no tras una respuesta; errores y estados; borrado de cuenta |
| N2 `Awaiting.test.tsx` | Lista con la evidencia y la duda; decisión sobre una posible respuesta; dejar de esperar; recordatorio a las 9:00 locales |
