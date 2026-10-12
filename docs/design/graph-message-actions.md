# Acciones sobre mensajes en Microsoft Graph (#141)

Implementación bajo [ADR-0004](../adr/0004-microsoft-graph.md). El ADR ya
aprueba pedir `Mail.ReadWrite` de forma incremental; este documento fija el
contrato de cada operación, la concurrencia y la reconciliación de la caché.
No introduce identidad nueva ni estado durable nuevo: el único dato añadido es
el nivel concedido, dentro del marcador de concesión que ya existía.

## Permiso

- **Por defecto, solo lectura.** La activación sigue pidiendo `Mail.Read`. Las
  escrituras se piden aparte, en una autorización explícita para esa cuenta
  («Permitir cambios»), que solicita `Mail.ReadWrite`. Nada pide `Mail.Send`.
- **Lo concedido manda.** El nivel es el que devuelve Microsoft, no el pedido.
  Si el inquilino recorta el permiso, la cuenta sigue en solo lectura y la
  interfaz lo dice.
- **Rechazar o cancelar** la autorización de cambios no toca la concesión
  existente: la lectura sigue igual.
- **Renovación.** Se pide el mismo nivel que se tenía. Si Microsoft rechaza la
  renovación con escritura (consentimiento retirado o denegado), se intenta una
  vez con lectura. Si funciona, la cuenta queda en solo lectura y se dice; si
  no, es una reautenticación como hasta ahora. La caché sin conexión se
  conserva en ambos casos.
- **Marcador.** El ajuste no secreto `graph.grant.<clave>` guarda ahora
  `{"writes": bool}`. Los marcadores antiguos (`true`) cuentan como solo
  lectura. Es una comprobación previa para no tocar la caché local: la
  autorización real es la concesión en el llavero, que se vuelve a comprobar
  en cada petición.

## Operaciones

Cada operación lleva `Prefer: IdType="ImmutableId"`, sin redirecciones, con el
mismo límite de tiempo y la misma clasificación de errores que la lectura, y
sin leer nunca el cuerpo de un error.

| Acción | Petición | Éxito |
|---|---|---|
| Leído / no leído | `PATCH /me/messages/{id}` con `{"isRead": b}` | 200 |
| Marca / sin marca | `PATCH /me/messages/{id}` con `{"flag": {"flagStatus": "flagged" \| "notFlagged"}}` | 200 |
| Mover | `POST /me/messages/{id}/move` con `{"destinationId": carpeta}` | 201 |
| Copiar (misma cuenta) | `POST /me/messages/{id}/copy` con `{"destinationId": carpeta}` | 201 |
| Borrar | mover a la carpeta con rol `deleteditems` | 201 |
| Borrar definitivamente | `DELETE /me/messages/{id}`, solo desde Elementos eliminados o Borradores | 204 |

- **Borrar** es recuperable: va a Elementos eliminados, igual que en IMAP va a
  la papelera. **Borrar definitivamente** solo ocurre desde Elementos
  eliminados o Borradores, como en IMAP. Graph lo deja en «Elementos
  recuperables», fuera de la vista del cliente.
- **Copiar a otra cuenta** desde o hacia Graph, vaciar carpeta, marcar todo
  como leído, crear o borrar carpetas, guardar como `.eml`, etiquetas remotas,
  borradores remotos y envío siguen sin soporte. Se rechazan antes de cualquier
  efecto local.
- **Deshacer** es la acción inversa, que pasa por el mismo camino que la
  original:
  - leído y marca se fijan al valor anterior;
  - mover y borrar a la papelera se deshacen moviendo de vuelta. Con
    identificadores inmutables el mensaje conserva su identificador y su UID
    local tras moverse (probado en la reconciliación);
  - si ya no está donde se dejó, el deshacer falla como cualquier movimiento,
    sin tocar nada;
  - borrar definitivamente no tiene deshacer.

## Conjunto revisado y concurrencia

- Los mensajes se resuelven a sus identificadores de Graph en una sola lectura
  de la base, antes de la primera petición. La resolución se hace por cuenta,
  carpeta y UID local. Un mensaje llegado después o de otra cuenta no puede
  entrar en el lote. Si un UID ya no está en esa carpeta, el lote no empieza.
- **Uno a uno.** Las peticiones van una tras otra. El primer fallo detiene el
  lote: no se sigue golpeando a un servidor que limita (429) ni a una concesión
  revocada (401/403).
- **Resultado del lote.** Un lote parcial devuelve cuántos se aplicaron de
  cuántos y el motivo del corte, con `Retry-After` si lo hubo. Nunca se
  presenta como éxito total.
- **Errores.** 403 es «sin permiso», 404 «ya no existe», 409/412 «conflicto» y
  429 «limitado», con la espera indicada.
- **Resultado incierto.** Si la conexión falla después de enviar la petición,
  el resultado es «incierto». No se repite sola:
  - mover, copiar y borrar no son idempotentes;
  - leído y marca sí lo son, y el usuario puede repetirlas a propósito.

## Reconciliación de la caché

- **Leído y marca.** La caché local se actualiza para cada mensaje confirmado,
  también en un lote parcial. El siguiente delta trae el mismo valor.
- **Mover, copiar y borrar.** Tras el lote, sea completo, parcial o incierto,
  se sincroniza por delta la carpeta de origen y la de destino. Así la caché
  refleja lo que hay en el servidor y no lo que se intentó. Con
  identificadores inmutables, un mensaje movido conserva su identificador y su
  UID local.
- **Fallo de reconciliación.** Si la reconciliación falla, por ejemplo por
  límite, la acción no se convierte en error. La siguiente sincronización
  normal la completa.
- **Datos locales.** Etiquetas locales y borradores locales no se tocan. IMAP
  y EWS no cambian. Graph nunca recurre a IMAP, SMTP ni EWS.

## Interfaz

- Una cuenta Graph sin permiso de cambios se comporta como hasta ahora: las
  acciones de escritura están deshabilitadas, también por teclado y en lote.
- Con permiso, se habilitan leído, marca, mover, borrar y copiar dentro de la
  cuenta. Lo que sigue sin soporte (vaciar carpeta, carpetas, `.eml`, envío)
  sigue deshabilitado.
- Ajustes de la cuenta muestra el nivel concedido y ofrece «Permitir cambios»
  o, si se perdió, el motivo.

## Pruebas

- **Transporte** (servidor de bucle local):
  - método, ruta, cabeceras y cuerpo de cada petición;
  - 200/201/204 como éxito;
  - 401/403/404/409/412/429 con `Retry-After` y 5xx clasificados;
  - corte de conexión como incierto;
  - id de respuesta ajeno como respuesta inválida;
  - una concesión sin `Mail.ReadWrite` no envía nada.
- **Sesión** (`Source` simulado):
  - resolución previa del conjunto, sin UIDs de otra carpeta;
  - parada en el primer fallo, con recuento;
  - actualización local de leído y marca en un lote parcial;
  - reconciliación por delta tras mover y borrar;
  - el resultado incierto no se repite.
- **Autorización:**
  - flujo de cambios con el alcance pedido;
  - nivel guardado según lo concedido;
  - renovación que conserva el nivel o cae a lectura;
  - marcador `writes`.
- **Despacho:**
  - el guardián deja pasar solo las acciones soportadas en cuentas con
    permiso;
  - una cuenta sin permiso sigue rechazando antes de efectos locales;
  - copiar entre cuentas sigue rechazado.
- **Puente e interfaz:** `oauth.graphBegin` con `writes` y habilitación de
  acciones según el nivel.
- **Proveedor real:** la certificación con un inquilino real queda en #98.
