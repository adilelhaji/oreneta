# ADR-0024: Ciclo de vida del envío (inmediato, retenido, programado) y pospuestos

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12. Cubre la puerta de #89 sobre el
  contrato duradero.
- Fecha: 2026-10-12.
- Alcance: #89.

## Contexto

El envío programado ya era duradero (`scheduled_sends` más los intentos de
#29). El periodo para deshacer, en cambio, solo vivía en un temporizador de
la interfaz: cerrar la app o un fallo en esos segundos perdía la respuesta.
Además:
- un «Enviar ahora» simultáneo con el vigilante podía dar por enviado, y
  borrar, un mensaje cuyo primer intento seguía en curso;
- la interfaz no decía que la app tiene que estar abierta;
- un hilo pospuesto que se movía desaparecía de todas partes.

## Decisión

- **Un solo camino duradero:**
  - una respuesta en su periodo para deshacer se guarda también como envío
    programado, con su Message-ID como id;
  - vence al final del periodo más un margen de 120 s;
  - dejarla ir o deshacerla borra antes esa copia;
  - si la app se cierra o falla, la copia sale al volver a abrirse;
  - la copia y la respuesta comparten id de intento, así que el núcleo nunca
    envía las dos.
- **Transiciones:**
  - retenido → (deshacer: borrado) | (vence: copia borrada → enviando);
  - programado → enviando → aceptado | archivado | rechazado (se reintenta
    con espera creciente, hasta 5 veces) | incierto (nunca se reintenta solo);
  - un intento «enviando» con la app en marcha está en curso: quien lo
    empezó lo cierra, y nadie más borra su fila;
  - al arrancar, lo que quedó «enviando» pasa a incierto antes de que empiece
    el vigilante.
- **Deshacer no es recuperar:**
  - solo existe antes de que el mensaje salga;
  - si la copia guardada no se puede borrar, se dice que aún puede salir.
- **Hora y reloj:**
  - las horas se guardan en segundos UTC; «mañana a las 8» se calcula en la
    hora local, así que el cambio de horario no la mueve;
  - un envío que sale más de 5 minutos tarde lo dice;
  - el menú avisa de que hace falta la app abierta.
- **Secretos:** la contraseña de una clave nunca se guarda con un mensaje
  programado.
- **Pospuestos:**
  - se guardan por conversación;
  - si la conversación se mueve, se encuentran en su carpeta actual;
  - una clave hecha de un uid no se busca en otra carpeta, porque allí ese
    uid es otro mensaje;
  - al despertar no se promete «de vuelta en la bandeja de entrada»: nunca
    se movió.

## Pendiente

- Que una respuesta nueva despierte antes una conversación pospuesta.
- Un periodo para deshacer también en el editor completo, que hoy envía al
  momento.
