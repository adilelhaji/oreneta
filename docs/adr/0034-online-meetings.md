# ADR-0034: Reuniones en línea en el calendario

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Sin servicio nuevo de pago.
- Fecha: 2026-10-12.
- Alcance: #109.

## Decisión

- **La reunión va unida a su evento:**
  - el evento guarda la reunión que da el servidor (Google:
    `conferenceData` y `hangoutLink`), en la columna `meeting` (esquema 52);
  - en cualquier calendario (Exchange, CalDAV, local o suscrito) se
    reconoce una dirección de reunión en el lugar o las notas: Meet, Zoom,
    Teams, Webex, Jitsi, GoTo y Whereby;
  - el reconocimiento es por dominio y ruta exactos, así que
    `meet.google.com.evil.test` no cuenta;
  - el evento muestra «Unirse a …», que abre la dirección fuera de la app.
- **Crear:**
  - solo Google Meet, solo en un calendario de una cuenta Google con OAuth,
    y solo si se marca «Añadir un Google Meet al guardar»;
  - se pide con `conferenceDataVersion=1` y un `requestId` fijo por evento,
    así que repetir el guardado tras perder la respuesta no crea una
    segunda reunión;
  - pedir un Meet a un evento que ya tiene uno no envía nada;
  - quitarlo envía `conferenceData: null`; una edición normal no toca la
    reunión;
  - si Google no la crea (cuenta sin Meet) o aún la prepara, se dice y el
    evento queda guardado.
- **Rechazado sin enviar nada:** crear una reunión en Exchange, CalDAV o un
  calendario local, o de un tipo distinto de Meet.
- **Bloqueado por el propietario:** Zoom, Teams, Webex y el resto necesitan
  registros OAuth o de aplicación propios de Oreneta; mientras no existan,
  se reconocen sus enlaces pero no se crean reuniones.

## Matriz

| Servicio | Reconocer enlace | Crear |
|---|---|---|
| Google Meet | sí | sí, en calendarios Google |
| Zoom | sí | bloqueado (registro) |
| Microsoft Teams | sí | bloqueado (Graph `OnlineMeetings`) |
| Webex | sí | bloqueado (registro) |
| Jitsi Meet | sí | no aplica |
| GoTo Meeting | sí | bloqueado (registro) |
| Whereby | sí | bloqueado (registro) |
| IceWarp, Meetn | no | bloqueado (sin documentación ni registro) |

## Pendiente

- N5: crear, editar y quitar un Meet en una cuenta Google de prueba.
- Teams en Exchange Online mediante Graph cuando exista el registro.
