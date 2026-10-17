# POP3 (#97)

Registre de la implementació de l'ADR-0035.

## Peces

- **Nucli:**
  - `meron-core/src/pop3/` conté el client (`CAPA`, `STLS`,
    `USER/PASS`, `UIDL`, `LIST`, `RETR` amb dot-stuffing, `DELE` i `QUIT`),
    la baixada, la política i el bloqueig per compte;
  - `pop3_seen` i `pop3_policy` (esquema 53) s'esborren amb el compte;
  - `Creds::is_pop3` i `is_local_store` fan que el compte es llegeixi com
    l'arxiu;
  - `sync_messages` baixa el correu quan es demana la safata d'entrada;
  - `account.connect` valida iniciant la sessió (tret que la persona triï «Desa
    igualment», #269, que no valida però continua exigint la contrasenya) i crea la
    safata d'entrada i la paperera;
  - RPC `pop3.retention`.
- **Go:** `incoming: "pop3"` en l'alta, amb el port 995 per defecte i sense
  vigilant IMAP.
- **Aplicació:** «Correu entrant: IMAP / POP3» a la configuració manual
  i «Correu al servidor POP3» a la configuració del compte, que pregunta
  abans d'esborrar.

## Proves

- **Servidor fals:**
  - una segona comprovació no baixa res;
  - es desfà el dot-stuffing;
  - un UIDL renumerat no duplica;
  - una baixada interrompuda desa el que s'ha baixat i continua després;
  - aturar-se entre desar i anotar no duplica;
  - l'esborrat al cap de N dies deixa la còpia d'aquí;
  - la paperera compta com a esborrat i moure no;
  - un `QUIT` perdut no esborra;
  - el que no és correu no es torna a demanar;
  - es comunica una contrasenya errònia;
  - sense TLS no s'envia la contrasenya;
  - la política per defecte és conservar.
- **Dovecot real** (`tests/dovecot-pop3.sh`, també a la CI): no es baixa res
  dues vegades, el correu es queda al servidor per defecte i, amb la política
  de dies, Dovecot l'esborra en el `QUIT` sense tocar la còpia d'aquí.
- **Go:** l'alta POP3 va com a POP3, al 995 i sense vigilant.
- **Aplicació:** la política només canvia després de confirmar-ho.
- **Trobat en provar-ho:** aturar-se entre desar i anotar produïa un
  duplicat. Corregit amb la comprovació per Message-ID i bytes.
