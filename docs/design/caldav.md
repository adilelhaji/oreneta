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

## Archivos .ics

En los ajustes de cada calendario, **Archivos de calendario**:
- **Importar .ics…** está en los calendarios locales y en los CalDAV con
  escritura. Primero dice cuántos eventos se añadirán, cuántos se repiten y
  cuántos ya están, y no añade nada dos veces.
  - En CalDAV, cada serie viaja con su regla, sus excepciones y sus zonas
    como un objeto propio.
  - En un calendario local, una serie se convierte en sus ocurrencias de
    los próximos 5 años (como mucho 512).
- **Exportar .ics…** escribe las ocurrencias que el calendario tiene aquí,
  aunque esté oculto, en un archivo que se renombra al terminar.

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
| N1 `calendar/import/tests.rs` y despachador | División por UID con excepciones y zonas; UID estable para componentes sin él; calendario local con eventos sueltos y serie acotada; vista previa sin guardar; segunda importación sin duplicados; exportación renombrada al terminar; calendario inexistente rechazado |
| N3 Radicale | Importar a CalDAV conserva la regla, y la segunda vez no añade nada |
| N2 `CalDavCalendars.test.tsx` (importar) | Confirmación con el resumen antes de importar; solo en locales y CalDAV con escritura |
| N2 `CalDavCalendars.test.tsx` | Buscar y elegir calendarios (solo lectura sin marcar); error del servidor visible; textos de quitar y regla del último calendario |
