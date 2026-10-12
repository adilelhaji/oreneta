# Chat (#110, #111)

Registro de la implementación de ADR-0036.

## Piezas

- **Núcleo:**
  - `meron-core/src/chat/`: el almacén (`chat_accounts`, `chat_messages`,
    `chat_reads`, esquema 54, con columna propia `chat_account`) y
    `xmpp.rs`, con el conector sobre `crate::tls`, la interpretación de
    stanzas y la sesión (archivo por páginas, carbons, recibos y ack);
  - RPC `chat.accounts/status/save/remove/conversations/history/markRead/send/retry`;
  - eventos `chat.changed` y `chat.status`;
  - las cuentas se conectan al arrancar.
- **Aplicación:** la vista «Chat» en la barra lateral (configuración,
  conversaciones con no leídos, historia con el estado de cada envío y
  «Enviar de nuevo»).

## Pruebas

- **Almacén:**
  - un mensaje una vez por id o por id de archivo;
  - estados solo hacia delante y uno perdido queda incierto sin reenviarse;
  - el archivo lo da por aceptado;
  - no leídos y lectura que no retrocede;
  - aislamiento entre cuentas y borrado.
- **Stanzas:**
  - mensaje entrante y propio desde otro dispositivo;
  - un id de archivo falsificado por otro servidor se ignora;
  - grupo, error y vacíos no cuentan;
  - lo que se envía lleva `origin-id` y pide recibo.
- **Prosody real** (`tests/prosody-xmpp.sh`, también en CI):
  - entrega en directo con recibo;
  - con el destinatario desconectado, el mensaje llega desde el archivo una
    sola vez, también tras volver a conectar otra vez.
- **Aplicación:**
  - lista con no leídos, estados visibles;
  - «Enviar de nuevo» solo al pulsar, con el mismo id;
  - envío con Intro;
  - lectura al llegar en la conversación abierta;
  - alta de cuenta.
- **Encontrado al probar:** la auditoría axe vio un elemento que no era
  `li` dentro de la lista de mensajes; corregido.
