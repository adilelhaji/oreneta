# ADR-0034: Reunions en línia al calendari

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Sense servei nou de pagament.
- Data: 2026-10-12.
- Abast: #109.

## Decisió

- **La reunió va unida al seu esdeveniment:**
  - l'esdeveniment desa la reunió que dona el servidor (Google:
    `conferenceData` i `hangoutLink`), a la columna `meeting` (esquema 52);
  - en qualsevol calendari (Exchange, CalDAV, local o subscrit) es
    reconeix una adreça de reunió al lloc o a les notes: Meet, Zoom,
    Teams, Webex, Jitsi, GoTo i Whereby;
  - el reconeixement és per domini i ruta exactes, de manera que
    `meet.google.com.evil.test` no compta;
  - l'esdeveniment mostra «Unir-se a …», que obre l'adreça fora de l'aplicació.
- **Crear:**
  - només Google Meet, només en un calendari d'un compte Google amb OAuth,
    i només si es marca «Afegir un Google Meet en desar»;
  - es demana amb `conferenceDataVersion=1` i un `requestId` fix per esdeveniment,
    de manera que repetir el desament després de perdre la resposta no crea una
    segona reunió;
  - demanar un Meet per a un esdeveniment que ja en té un no envia res;
  - treure'l envia `conferenceData: null`; una edició normal no toca la
    reunió;
  - si Google no la crea (compte sense Meet) o encara la prepara, es diu i
    l'esdeveniment queda desat.
- **Rebutjat sense enviar res:** crear una reunió a Exchange, CalDAV o un
  calendari local, o d'un tipus diferent de Meet.
- **Bloquejat pel propietari:** Zoom, Teams, Webex i la resta necessiten
  registres OAuth o d'aplicació propis d'Oreneta; mentre no existeixin,
  se'n reconeixen els enllaços però no es creen reunions.

## Matriu

| Servei | Reconèixer l'enllaç | Crear |
|---|---|---|
| Google Meet | sí | sí, en calendaris Google |
| Zoom | sí | bloquejat (registre) |
| Microsoft Teams | sí | bloquejat (Graph `OnlineMeetings`) |
| Webex | sí | bloquejat (registre) |
| Jitsi Meet | sí | no s'aplica |
| GoTo Meeting | sí | bloquejat (registre) |
| Whereby | sí | bloquejat (registre) |
| IceWarp, Meetn | no | bloquejat (sense documentació ni registre) |

## Pendent

- N5: crear, editar i treure un Meet en un compte Google de prova.
- Teams a Exchange Online mitjançant Graph quan existeixi el registre.
