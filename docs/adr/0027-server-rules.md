# ADR-0027: Reglas en el servidor

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Cubre la puerta de #94
  (adaptadores y permisos nuevos por proveedor).
- Fecha: 2026-10-12.
- Alcance: primera entrega de #94.

## Inventario por proveedor

| Proveedor | Reglas en el servidor | Respuesta automática y reenvío | Estado |
|---|---|---|---|
| IMAP con ManageSieve (RFC 5804; Dovecot Pigeonhole, Fastmail, Stalwart…) | Script Sieve | `vacation` y `redirect` de Sieve | **Reglas: implementado.** Respuesta automática y reenvío: no |
| Gmail | Filtros de la API de Gmail (`settings.filters`) | `settings.sendAs`, `vacation`, reenvío verificado | Bloqueado: permiso `gmail.settings.basic` y registro OAuth propio |
| Exchange EWS | `GetInboxRules` / `UpdateInboxRules` | OOF ya existe (#48); el reenvío es una regla | Bloqueado: hacen falta grabaciones reales, que no se inventan |
| Microsoft Graph | `messageRules` | `mailboxSettings.automaticRepliesSetting` | Bloqueado: permiso `MailboxSettings.ReadWrite` y consentimiento |
| Archivo local, RSS | No aplica | No aplica | — |

## Decisión

- **Las mismas reglas, en otro sitio:**
  - las reglas de Oreneta se traducen a un script Sieve llamado `oreneta`;
  - una regla solo va al servidor si Sieve dice exactamente lo mismo, o
    algo más estrecho en casos de espacios, nunca algo más amplio;
  - si alguna parte no se puede decir, la regla entera se queda aquí, con
    el motivo a la vista;
  - ejemplos que se quedan: «es» o «empieza por» en una dirección, que aquí
    compara también el nombre; un texto que mezcla nombre y dirección; una
    etiqueta no enlazada a una palabra clave; una extensión que el servidor
    no ofrece.
- **Qué se escribe y qué no:**
  - solo se escribe el script `oreneta`;
  - si la copia del servidor cambió desde la última escritura, se muestra y
    no se reemplaza sin permiso;
  - nunca se desactiva otro script activo; si hay uno, el de Oreneta queda
    guardado pero apagado, y se dice;
  - el servidor comprueba el script (`CHECKSCRIPT`) antes de guardarlo.
- **Sin aplicar dos veces:**
  - con el script activo, el motor local se salta esas reglas en esa cuenta
    (`server_rules`);
  - al quitarlas del servidor vuelven a funcionar aquí;
  - un script guardado pero inactivo no quita nada de aquí.
- **Seguridad:**
  - ManageSieve solo con STARTTLS y la contraseña de la cuenta;
  - un servidor sin TLS se rechaza;
  - las cuentas OAuth no usan ManageSieve.
- **Sin reenvíos ni respuestas automáticas en el servidor:** ninguna prueba
  ni acción activa un reenvío a un tercero.

## Pendiente

- Respuesta automática con `vacation` de Sieve.
- Adaptadores para Gmail, EWS y Graph, cuando haya permisos y evidencia
  real.
- Prueba contra Dovecot Pigeonhole real (N5).
