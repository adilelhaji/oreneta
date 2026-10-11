# Calendarios suscritos: lectura según RFC 5545 (#100, #101)

Un calendario suscrito es un archivo `.ics` publicado por otro. Oreneta lo
descarga y expande sus series él mismo, en `meron-core/src/calendar/subscription.rs`.
Los defectos de abajo se reprodujeron con fixtures antes de corregirlos.

## Qué se corrige

| Antes | Ahora |
|---|---|
| Un evento de día completo se mostraba un día antes al este de UTC: la expansión lo situaba a medianoche local y el calendario lo lee como fecha UTC. | Se conserva la fecha del evento, sea cual sea la zona del equipo. |
| Una ocurrencia movida (`RECURRENCE-ID`) aparecía dos veces, y una cancelada seguía apareciendo. | La serie se agrupa por `UID`. La excepción sustituye a la ocurrencia que nombra y, si está cancelada, la quita. Se identifica por la fecha original, así que volver a moverla actualiza la misma fila. |
| `DURATION` se ignoraba y el evento duraba cero. | `DTEND`; si falta, `DTSTART` + `DURATION`; si tampoco, un día para un evento de día completo (RFC 5545 §3.6.1). |
| Una hora flotante (sin zona) daba duración cero. | Se lee en la hora del equipo, que es lo que significa «flotante». |
| Un `TZID` con nombre de Windows (`W. Europe Standard Time`, como publica Outlook) hacía descartar la serie entera. | Se traduce a IANA con la tabla de CLDR antes de expandir. |
| Un evento que empezaba antes de la ventana y seguía dentro (de domingo a martes en una semana que empieza el lunes) desaparecía. | Se busca hacia atrás tanto como dura el evento, con un máximo de 31 días. |
| Una suscripción que fallaba al descargarse o leerse detenía la sincronización del resto de calendarios de la cuenta. | Esa suscripción conserva sus últimos eventos y se registra el motivo. Las demás se actualizan. |
| Los enlaces `webcal://`, la forma habitual de publicar una suscripción, se rechazaban. | Se descargan por HTTPS. Otros esquemas se siguen rechazando. |

## Pruebas

- **Núcleo** (`calendar::subscription::tests`): excepción movida, cancelada y
  `EXDATE`; `DURATION` y finales ausentes; serie de días completos; zona de
  Windows a través del cambio de hora del 25-10-2026; 29 de febrero anual;
  evento que cruza el inicio de la ventana; hora flotante; `webcal`; formato
  de duraciones; y que cada entrada de la tabla de Windows sea una zona real.
- **Zonas distintas de UTC.** CI ejecuta las pruebas de calendario también con
  `TZ=Asia/Tokyo` y `TZ=America/Los_Angeles`. En UTC, fecha e instante
  coinciden y el fallo de los días completos no se ve. Con el código anterior
  y `TZ=Europe/Madrid`, la prueba de días completos falla.
- **Interfaz** (`subscriptionUrl.test.ts`): el diálogo acepta `webcal://` y
  `webcals://`, y rechaza lo mismo que el núcleo.

## Pendiente

- **Hora ambigua en el cambio de hora.** Un `DTSTART` en la hora que se repite
  sigue haciendo fallar la expansión de esa serie en la biblioteca `rrule`, y
  la serie se omite contándola como ilegible.
- **Fuera de las suscripciones.** Los eventos de día completo de Exchange, los
  conflictos al editar y la edición de series completas están en la misma
  auditoría y se tratan aparte.
