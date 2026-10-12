# ADR-0032: Contexto, proveedor y consentimiento del asistente

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Sin servicio nuevo de pago:
  el proveedor lo elige y configura la persona.
- Fecha: 2026-10-12.
- Alcance: #51 y la parte estable de #52.

## Decisión

- **Activación:**
  - el asistente está apagado por omisión (`assistant_enabled`);
  - apagado, no aparece en conversaciones ni en el composer;
  - encendido, cada petición sigue necesitando revisión y confirmación, que
    el núcleo exige: sin la casilla marcada y un token igual al de la vista
    previa, no se envía nada.
- **Proveedor:**
  - formato de chat completions (OpenAI), el que entienden Ollama,
    llama.cpp y LM Studio en local y los proveedores remotos;
  - en modo local, solo una dirección de este equipo (loopback);
  - en modo remoto, solo HTTPS;
  - la clave se pide en cada petición y no se guarda.
- **Contexto:**
  - en una conversación, solo los mensajes y adjuntos que la persona marca:
    id del mensaje, cuenta, remitente, asunto, texto y nombre, tipo y
    tamaño de los adjuntos;
  - no se envían destinatarios, fechas ni otras cuentas o conversaciones;
  - al reescribir, solo el texto del borrador.
  - Una prueba falla si aparece un campo nuevo en lo que se envía.
- **Lo que se revisa es lo que sale:**
  - la vista previa del núcleo devuelve el cuerpo exacto de la petición;
  - el token es su hash junto con el proveedor, y al ejecutar se rehace y se
    compara;
  - el diálogo muestra el destino y el cuerpo exacto.
- **El correo es dato, no órdenes:**
  - va dentro de `<mail>…</mail>` como JSON, así que no puede cerrar la
    valla;
  - las instrucciones del sistema dicen que no se obedece nada de dentro y
    que no se puede actuar sobre el buzón;
  - de la respuesta solo se lee `text`, `sources` y `tasks`, y fuentes y
    tareas fuera del contexto revisado se descartan;
  - nada de la respuesta envía, borra, mueve o cambia reglas: un borrador se
    abre para editar, una tarea se crea al pulsar y una reescritura se usa
    al pulsar, con deshacer.
- **Cancelar:** responde en el momento, aunque la petición esté en curso, y
  la respuesta tardía se descarta.
- **Registro:**
  - nada se guarda;
  - un error del proveedor se informa solo con su estado, porque su cuerpo
    puede citar el correo y los errores se registran.
- **Escritura (#52):**
  - además de resumen, respuesta y tareas sugeridas, se puede reescribir el
    borrador: corregir, más formal, más amable, más corto o más largo;
  - la instrucción es una de esas, nunca texto libre.

## Alternativas

- Formato propio (lo que había): no lo entendía ningún servidor real.
- Activación por cuenta: más fina, pero la confirmación por petición ya es
  explícita; se puede añadir si el propietario lo pide.

## Pendiente (para el propietario)

- La política de privacidad pública (`docs/privacy.html`) debe decir que,
  si se activa el asistente en modo remoto, el texto revisado se envía al
  proveedor elegido, y que las descargas de modelos de traducción solo
  ocurren a petición. Afecta a la sección de Google (Limited Use): un
  envío a un tercero elegido por la persona necesita revisión antes de la
  verificación de Google. Texto propuesto en el registro de diseño.
- Separar en #117 la extracción de eventos y las funciones de agente de la
  versión 11.
