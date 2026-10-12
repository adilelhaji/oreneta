# Exposición a la retirada de EWS en Exchange Online (#46)

Estudio con fecha 2026-10-10. No afirma continuidad: dice qué cuentas y qué
funciones están expuestas, qué cubre ya Graph y qué decisión queda.

## Calendario de Microsoft

Comprobado el 2026-10-10 en el blog del equipo de Exchange y en el aviso
MC1227454:

- **Desde octubre de 2026.** Empieza la desactivación por fases en Exchange
  Online. Desde el 10 de octubre, en la nube mundial, un inquilino con
  `EWSEnabled = True` necesita una lista `EWSAllowedAppIDs`; sin lista, EWS
  queda bloqueado. Microsoft rellena la lista con unos 60 días de uso en los
  inquilinos que no la configuraron.
- **1 de abril de 2027.** Retirada completa, sin excepciones.
- **Exchange Server local no se ve afectado.**

Fuentes:
- [Exchange Online EWS, Your Time is Almost Up](https://techcommunity.microsoft.com/blog/exchange/exchange-online-ews-your-time-is-almost-up/4492361)
- [Introducing EWSAllowedAppIDs](https://techcommunity.microsoft.com/blog/exchange/introducing-ewsallowedappids-preparing-for-the-final-phase-of-ews-retirement/4529471)
- [EWS Deprecation Is Here](https://techcommunity.microsoft.com/blog/exchange/ews-deprecation-is-here-%E2%80%93-what-this-means-to-you/4561431)
- [MC1227454](https://mc.merill.net/message/MC1227454)

Antes de decidir, conviene volver a comprobar las fechas en el Centro de
mensajes del inquilino.

## Hallazgo: EWS en Oreneta ya era solo local

El cliente EWS de Oreneta (`exchange.rs`) se autentica solo con Basic, es
decir, usuario y contraseña. Exchange Online desactivó Basic para EWS en
octubre de 2022. Por tanto:

- **Exchange Online.** Una cuenta EWS de Oreneta apuntada allí no podía
  conectarse antes de esta retirada, y la retirada no cambia eso.
- **Exchange local.** Las cuentas contra un servidor local, que es el uso
  real, no están afectadas.
- **Exposición.** No es «las cuentas EWS dejan de funcionar». Es que un
  usuario de Microsoft 365 nunca ha tenido por EWS lo que solo EWS ofrece en
  Oreneta: calendario, contactos de Exchange, respuestas automáticas del
  servidor, directorio y buzones compartidos.

## Cómo identificar las cuentas expuestas

- `account.list` marca con `ews_exchange_online: true` toda cuenta EWS cuyo
  extremo es Exchange Online: `outlook.office365.com`, `outlook.office.com` o
  las nubes nacionales `.us`, `.de` y `partner.outlook.cn`
  (`exchange::is_exchange_online`).
- Ajustes de esa cuenta muestra el aviso con la salida: quitarla y añadir el
  buzón como Microsoft Graph. Convertirla en el sitio no está permitido por
  ADR-0004.
- El inventario de las cuentas reales del piloto lo hace el responsable con
  esa marca. Este estudio no tiene acceso a ellas.

## Matriz de capacidades

| Función | EWS local (Oreneta) | Exchange Online por EWS | Graph en Oreneta hoy | Permiso Graph | Estado |
|---|---|---|---|---|---|
| Leer correo, carpetas, sincronizar | Sí | No (Basic) | Sí (#128) | `Mail.Read` | Cubierto |
| Leído, marca, mover, copiar, borrar | Sí, salvo estrella | No | Sí (#141) | `Mail.ReadWrite` | Cubierto |
| Adjuntos y en línea | Sí | No | Sí, hasta 64 MiB (#142) | `Mail.Read` | Cubierto con límite |
| Enviar | Sí | No | Sí, hasta 4 MB (#143) | `Mail.Send` | Cubierto con límite |
| Borradores en el servidor | No | No | No | `Mail.ReadWrite` | Hueco (S) |
| Envío de más de 4 MB (sesión de carga) | — | — | No | `Mail.ReadWrite` | Hueco (M) |
| Envío programado | Sí, local | No | No | — | Hueco (S) |
| Calendario y respuestas a invitaciones | Sí | No | No | `Calendars.ReadWrite` | Hueco (L) |
| Libre/ocupado | Sí (resolución de nombres) | No | No | `Calendars.Read.Shared` | Hueco (M) |
| Contactos de Exchange | Sí | No | No | `Contacts.ReadWrite` | Hueco (M) |
| Directorio (GAL) | Sí | No | No | `People.Read` / `User.ReadBasic.All` | Hueco (S) |
| Respuestas automáticas del servidor | Sí | No | No | `MailboxSettings.ReadWrite` | Hueco (S) |
| Buzones compartidos | Sí (acceso completo) | No | No | `Mail.Read.Shared`, `Mail.Send.Shared` | Hueco (M) y #48 |
| Reglas del servidor | No | No | No | `MailboxSettings.ReadWrite` | Fuera de alcance (#94) |
| Nubes nacionales | — | — | No | — | Fuera de alcance (ADR-0004) |

Notas:
- «Sí» significa implementado y con pruebas en este repositorio. No
  significa certificado con un proveedor (#98).
- Los límites de Graph y la paginación, el `Retry-After`, los tokens
  revocados y la sincronización delta están en
  [graph-adapter.md](../graph-adapter.md), [graph-message-actions.md](graph-message-actions.md),
  [graph-attachments.md](graph-attachments.md) y [graph-sending.md](graph-sending.md).

## Decisión que queda (responsable)

- **Plazo.** Antes del 1 de abril de 2027 para el correo de Microsoft 365, que
  ya está cubierto por Graph. Para calendario y contactos el plazo lo fija el
  piloto, no Microsoft: con Exchange Online nunca han funcionado en Oreneta.
- **Rebanadas propuestas.** En orden, con estimación orientativa en días de
  trabajo de una persona, pruebas incluidas:
  1. Calendario Graph: lectura, creación, respuesta y recurrencia. 10–20 días.
  2. Respuestas automáticas del servidor por Graph. 2–4 días.
  3. Directorio y libre/ocupado. 3–6 días.
  4. Contactos de Exchange por Graph. 5–8 días.
  5. Borradores en el servidor y sesiones de carga para envíos grandes. 5–8
     días.
  6. Buzones compartidos con `.Shared`, junto con #48. 6–10 días.
- **Rango total.** Entre 31 y 56 días de trabajo, más la certificación con un
  inquilino real (#98), que necesita una cuenta de prueba autorizada.
- **Consentimiento.** Cada rebanada pide su permiso de forma incremental,
  como ya hacen cambios y envío. Ningún permiso se pide de golpe.
- **Lo que el responsable debe decidir:**
  - quién es responsable;
  - qué rebanadas entran antes del piloto;
  - si se acepta usar `.Shared`, que amplía ADR-0004.

## Validación

- `exchange::tests::exchange_online_endpoints_are_told_apart_from_on_premises_servers`
  distingue extremos en línea y locales, incluidos casos engañosos.
- Las cuentas marcadas se ven en Ajustes con el aviso.
- No hay evidencia contra un inquilino real. Este estudio no la sustituye.
