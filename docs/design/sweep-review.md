# Barrido sobre el conjunto revisado (#27)

Contrato de implementación de la primera slice de #27. Cubre el barrido por
remitente desde escritorio: vista previa, confirmación y resultado. No añade
persistencia ni acciones masivas nuevas.

## Problema reproducido

La confirmación volvía a calcular los candidatos (`mail.sweep` en el puente Go
llamaba otra vez a la vista previa y pasaba la lista recalculada a
`messages.move`). Un mensaje del mismo remitente llegado después de la vista
previa entraba en el barrido sin que nadie lo hubiera visto (H01); con
`keep_newest = 1`, además, el que antes era el más reciente pasaba a ser
candidato. Un doble clic ejecutaba dos barridos y el resultado se presentaba
como éxito total aunque el movimiento fallara a medias.

## Contrato

- `mail.sweepPreview` emite una **revisión** (`reviewId`): cuenta, carpeta,
  `UIDVALIDITY` de la carpeta en ese momento y los UID exactos mostrados, en
  orden. Vive en memoria del motor (`sweep_review::Registry`), de un solo uso,
  caduca a los 15 minutos y se guardan como máximo 64 pendientes.
- `mail.sweepExecute {account, review_id}` consume la revisión. Se rechaza con
  mensaje explícito si no existe, ya se usó o caducó («vuelva a previsualizar»),
  si pertenece a otra cuenta, o si la `UIDVALIDITY` actual de la carpeta no es
  la revisada (los UID podrían nombrar otros mensajes). Nada se mueve en esos
  casos.
- Con la revisión válida, mueve exactamente esos UID a la papelera mediante la
  misma operación `messages.move`, sin recalcular. Después comprueba en la caché
  qué UID revisados siguen en la carpeta de origen y responde por elemento:
  `swept`, `sweptUids`, `unresolved`, `complete` y `error`. `complete` solo es
  verdadero sin error y sin elementos pendientes.
- El puente Go deja de recalcular: `mail.sweep` exige `review_id` y devuelve la
  respuesta del motor sin tocarla.
- La interfaz confirma con el `reviewId` de la vista previa, queda ocupada hasta
  cerrarse (la revisión es de un solo uso) y, si el resultado no es completo,
  avisa con los movidos y los pendientes en lugar de un recuento de éxito.
  Un fallo cierra el diálogo: lo mostrado ya no es lo que se movería.

## Decisión pendiente, no tomada aquí

La discusión de la issue dejaba abierta la elección entre revisión efímera en
memoria y diario durable de operaciones con resultados por elemento que
sobrevivan a un reinicio. Esta slice implementa la **revisión efímera**: un
reinicio invalida la vista previa, que cuesta un clic repetir. El diario
durable sigue siendo una decisión del responsable (#24/#25); su ausencia no
reintroduce ninguno de los cuatro riesgos de aceptación.

## Verificación

- Rust: `sweep_review::tests` (un solo uso, cuenta equivocada, caducidad,
  tope, `UIDVALIDITY` cambiada, resultado parcial).
- Go: `TestMailSweepConfirmsTheReviewedPreview`, `TestMailSweepRefusesToActWithoutAReview`.
- Integración maddy: vista previa, llegada de un mensaje nuevo del mismo
  remitente, confirmación que lo deja en la bandeja, segunda confirmación
  rechazada.
- Frontend: `priority.test.ts` para el aviso de resultado parcial.
- No cubierto: cambio real de `UIDVALIDITY` en un servidor (unitario solamente),
  interrupción física a mitad de un `MOVE` (el resultado por elemento se
  calcula desde la caché tras la operación) y proveedores reales.
