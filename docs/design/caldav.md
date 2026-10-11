# Calendarios CalDAV (#101, ADR-0018)

## Uso

**Añadir calendario → Servidor CalDAV**:
1. Se escriben el servidor (o la dirección), el usuario y la contraseña.
2. **Buscar calendarios** lista los que hay. Los de solo lectura aparecen
   sin marcar.
3. **Añadir** los guarda bajo la cuenta elegida.

Se leen y se editan como los demás calendarios. Si alguien cambió un evento
en otro dispositivo, al guardar no se escribe nada: se avisa y se refresca.
Quitarlo aquí no lo borra del servidor.

## Defectos encontrados al probar

- **Radicale** reescribe `DTSTART;TZID=Etc/UTC:…` como `…Z` junto al
  `TZID`, y el lector descartaba la serie entera. Ahora un `Z` gana sobre
  el `TZID`, y las zonas UTC se escriben en UTC plano.
- **Llamadas al núcleo:**
  - el descubrimiento CardDAV heredaba el límite de 5 s, y ahora tiene 60 s
    como CalDAV;
  - la ventana de quitar decía «van a Elementos eliminados del servidor»
    también para calendarios locales, suscritos y CalDAV;
  - la regla «una cuenta conserva al menos un calendario» impedía quitar
    el único calendario local, suscrito o CalDAV listado bajo una cuenta.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `calendar/ics/tests.rs` | Escape y plegado; ida y vuelta de un evento; día completo; serie que mantiene su hora local tras el cambio de hora; edición que conserva asistentes, organizador, X- y sustituye la alarma; desplazamiento de serie que conserva la primera fecha; excepción, segunda excepción que reemplaza y EXDATE; recordatorios; exportación; UTC plano; `Z` con `TZID` |
| N1 `calendar/caldav/tests.rs` | Descubrimiento por el principal con permisos y colores; crear, leer versión, conflicto sin escritura y edición desde la versión actual; ocurrencias cambiadas y borradas; ventana incompleta rechazada; nada enviado a otro servidor |
| N1 guarda ADR-0011 | `caldav_objects` se borra con la cuenta; las contraseñas también |
| N3 `integration_caldav_test.go` (Radicale) | Descubrir y añadir; edición que conserva asistentes y líneas ajenas; conflicto sin escritura; serie con una ocurrencia cambiada y otra borrada |
| N2 `CalDavCalendars.test.tsx` | Buscar y elegir calendarios (solo lectura sin marcar); error del servidor visible; textos de quitar y regla del último calendario |
