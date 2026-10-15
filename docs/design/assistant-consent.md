# Asistente: contexto y consentimiento (#51, #52)

Registro de la implementación de ADR-0032.

## Defectos encontrados y corregidos

- **Formato incompatible:** la petición usaba un formato propio contra
  `/v1/chat/completions`, así que no funcionaba con Ollama ni con ningún
  proveedor real. Ahora usa chat completions y lee
  `choices[0].message.content`.
- **Errores en el registro:** el cuerpo de un error del proveedor, que
  puede citar el correo, acababa en el registro de la app.
- **Cancelar:** solo se comprobaba antes y después de la petición; con un
  proveedor lento había que esperar hasta 60 s.
- **Revisión incompleta:** lo que se enseñaba no incluía la petición real
  (adjuntos, instrucciones). Ahora se enseña el cuerpo exacto, atado al
  token.
- **Sin activación:** el botón aparecía siempre. Ahora está apagado por
  omisión.

## Pruebas

- **Núcleo:**
  - solo salen los campos revisados (lista exacta de claves);
  - una inyección no cierra la valla;
  - instrucciones de reescritura permitidas;
  - un proveedor falso en este equipo recibe exactamente el cuerpo revisado
    y la clave;
  - un error 500 se informa sin su cuerpo;
  - cancelar responde en menos de 2 s con el proveedor tardando 5 s.
- **Aplicación:**
  - apagado por omisión;
  - JSON en bloque de código, y las «acciones» de la respuesta se ignoran;
  - el diálogo de revisión de una conversación empieza con solo el mensaje
    más reciente marcado (la fecha mayor; con fechas iguales o
    desconocidas, el último de la lista) y ningún detalle de adjunto; lo
    demás lo añade la persona, y la vista previa cambia con cada casilla
    (#196, `AssistantReviewDialog.test.tsx`);
  - un borrador no cuenta como el más reciente, salvo si la conversación
    solo tiene borradores; un envío pendiente (enviando, enviado o fallido)
    sí cuenta, porque es un mensaje de la persona y no un borrador;
  - la selección vuelve a ese valor solo cuando llega un mensaje más
    reciente: una sincronización, un cambio de marca o páginas antiguas
    conservan lo marcado, y la misma petición no se vuelve a previsualizar
    ni se borra el resultado mostrado;
  - el diálogo de reescritura enseña el destino y el cuerpo exacto, exige
    confirmar otra vez si cambia la petición, no cambia nada hasta «Usar» y
    al parar cancela y descarta la respuesta tardía.
- **e2e:** sin activar no se ofrece; activado aparece en el composer.

## Texto propuesto para `docs/privacy.html` (decide el propietario)

> **Optional assistant.** Off unless you turn it on. When you ask it to
> summarise, draft or rewrite, Oreneta shows the exact text it would send
> and where, and sends it only after you confirm: to a model on your own
> computer, or to the HTTPS provider you configured. Nothing is kept.
>
> **Translation models.** Downloaded from Mozilla's model storage only when
> you ask for a language; translating happens on your computer.
