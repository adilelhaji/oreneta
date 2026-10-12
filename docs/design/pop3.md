# POP3 (#97)

Registro de la implementación de ADR-0035.

## Piezas

- **Núcleo:**
  - `meron-core/src/pop3/` contiene el cliente (`CAPA`, `STLS`,
    `USER/PASS`, `UIDL`, `LIST`, `RETR` con dot-stuffing, `DELE` y `QUIT`),
    la descarga, la política y el bloqueo por cuenta;
  - `pop3_seen` y `pop3_policy` (esquema 53) se borran con la cuenta;
  - `Creds::is_pop3` y `is_local_store` hacen que la cuenta se lea como el
    archivo;
  - `sync_messages` descarga al pedir la Bandeja de entrada;
  - `account.connect` valida iniciando sesión y crea Bandeja y Papelera;
  - RPC `pop3.retention`.
- **Go:** `incoming: "pop3"` en el alta, con puerto 995 por omisión y sin
  vigilante IMAP.
- **Aplicación:** «Correo entrante: IMAP / POP3» en la configuración manual
  y «Correo en el servidor POP3» en los ajustes de la cuenta, que pregunta
  antes de borrar.

## Pruebas

- **Servidor falso:**
  - una segunda comprobación no descarga nada;
  - se deshace el dot-stuffing;
  - un UIDL renumerado no duplica;
  - una descarga cortada guarda lo anterior y sigue después;
  - parar entre guardar y anotar no duplica;
  - el borrado tras N días deja la copia aquí;
  - la Papelera cuenta como borrado y mover no;
  - un `QUIT` perdido no borra;
  - lo que no es correo no se vuelve a pedir;
  - una contraseña errónea se dice;
  - sin TLS no se envía la contraseña;
  - la política por omisión es conservar.
- **Dovecot real** (`tests/dovecot-pop3.sh`, también en CI): nada se
  descarga dos veces, el correo se queda en el servidor por omisión, y con
  la política de días Dovecot lo borra al `QUIT` sin tocar la copia de aquí.
- **Go:** el alta POP3 va como POP3, al 995 y sin vigilante.
- **Aplicación:** la política solo cambia tras confirmar.
- **Encontrado al probar:** parar entre guardar y anotar producía un
  duplicado. Corregido con la comprobación por Message-ID y bytes.
