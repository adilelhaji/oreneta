# ADR-0018: Calendarios CalDAV

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-11.
- Alcance: el adaptador CalDAV de #101.

## Contexto

Exchange y Google ya sincronizan calendarios; una cuenta IMAP no tiene
ninguno. #101 pide CalDAV y exige decidir antes la identidad de las
recurrencias.

## Alternativas

1. **Calendarios CalDAV como fuente propia, listados bajo una cuenta
   (elegida).** Se descubren con su propio usuario y contraseña, como las
   libretas CardDAV, y valen para cualquier cuenta: Fastmail, iCloud,
   Nextcloud o Radicale.
2. **Una ruta CalDAV deducida del servidor de correo.** Pocas veces es el
   mismo host, y obligaría a adivinar.
3. **Expansión de recurrencias en el servidor** (`<C:expand>`). No todos los
   servidores la implementan, y perderíamos la regla, que hace falta para
   escribir.

## Decisión

- **Descubrimiento:** principal → `calendar-home-set` → colecciones con
  `resourcetype` calendar. Se reutiliza el transporte de CardDAV con sus
  reglas: la contraseña nunca baja de HTTPS a HTTP, nunca sale a otro
  origen salvo por HTTPS, y una escritura solo va al servidor del calendario
  (#28).
- **Permisos:** `current-user-privilege-set`; un calendario de solo lectura
  se muestra y no se edita.
- **Lectura:** `calendar-query` con `time-range` de la ventana, y expansión
  aquí con el mismo lector RFC 5545 de las suscripciones. Es todo o nada: si
  falta un objeto, se conserva la ventana anterior.
- **Identidad:**
  - cada ocurrencia es `{UID}@{inicio original}`, como en las suscripciones;
  - se guarda dónde vive cada UID (`caldav_objects`: href y ETag);
  - la versión del objeto viaja como `change_key` de cada ocurrencia.
- **Escritura:**
  - **Nuevo evento:** objeto nuevo con `If-None-Match: *`.
  - **Editar un evento o la serie:** se toma el objeto del servidor, se
    comprueba que sigue en la versión que se vio y se envía con `If-Match`.
    Al editar la serie desde una ocurrencia, el cambio se traslada como
    desplazamiento, así que la serie conserva su primera fecha.
  - **Editar una ocurrencia:** componente de excepción con
    `RECURRENCE-ID`.
  - **Borrar una ocurrencia:** `EXDATE`.
  - **Borrar la serie:** `DELETE` con `If-Match`.
  - En todos los casos se conserva línea a línea lo que esta aplicación no
    edita: asistentes, organizador, propiedades X- y zonas.
- **Conflicto:** si la versión cambió (412 o un ETag distinto), no se
  escribe nada, se dice y se refresca el calendario (política de ADR-0012).
- **Zonas:**
  - un evento único se escribe en UTC;
  - una serie, en su zona IANA (la que ya tenía, o la del equipo), para que
    no se mueva una hora en cada cambio de hora; las zonas equivalentes a
    UTC se escriben en UTC plano;
  - al leer, un `…Z` junto a un `TZID` es UTC, porque Radicale (vobject)
    escribe esa forma.
- **Quitar el calendario:** deja de mostrarse aquí y sigue en su servidor.
  Al quitar la cuenta se borran sus filas y sus contraseñas (ADR-0011).

## Consecuencias

- Pruebas:
  - N1 con un servidor falso con estado (descubrimiento, versiones,
    conflictos, ocurrencias, origen);
  - N3 contra Radicale en el job de integración: edición que conserva
    asistentes, conflicto sin escritura, serie con excepción y EXDATE.
- Queda fuera: cola sin conexión (las escrituras requieren red y fallan
  visiblemente sin ella), invitaciones (iMIP) y proveedores certificados
  (N5).
