# Edición de contactos: decisiones pendientes (#41)

Estado: **propuesta**. #41 pide aprobar estas decisiones antes de escribir
código. Hasta entonces no hay ninguna escritura de contactos.

## Qué existe hoy

- **Fuentes de solo lectura.** CardDAV (`meron-core/src/carddav`), Google
  People con el permiso `contacts.readonly` y contactos de Exchange.
- **Modelo.** `people` guarda el origen de cada contacto (`source`, `account`,
  `book`, `uid`), pero no su versión: no hay columna de ETag ni de `etag` de
  Google ni de `ChangeKey` de Exchange. Sin versión, una escritura no puede
  detectar un cambio ajeno.
- **#28** ya asegura que una sincronización incompleta no borra contactos.

## Decisiones

### 1. Qué fuentes se pueden editar

Propuesta, por orden:
1. **Una libreta local** («en este equipo»), sin servidor. Es el primer paso
   porque no depende de nada externo.
2. **CardDAV.** Escritura con `PUT` y `If-Match`, y alta con
   `If-None-Match: *`. Radicale ya está en CI para probarlo (N3).
3. **Google**, solo después de la decisión 2.
4. **Exchange**, solo con evidencia de un servidor real (la misma regla que
   el calendario).

Los directorios y libretas que el servidor marca como de solo lectura nunca
ofrecen edición. En CardDAV eso se lee de `current-user-privilege-set`.

### 2. Permiso de Google

Editar contactos exige cambiar `contacts.readonly` por `contacts`. Ese permiso
es sensible en la verificación de Google y afecta a la decisión pendiente de
#144 sobre registros OAuth propios. Propuesta: no pedirlo hasta tener el
registro propio, y pedirlo aparte, solo cuando alguien edite un contacto de
Google (como `Mail.ReadWrite` en Graph, #141).

### 3. Conflictos

Propuesta: guardar la versión de cada contacto (ETag, `etag` o `ChangeKey`) y
escribir siempre con ella. Si el servidor responde que ha cambiado (412),
no se guarda nada, se relee el contacto y se muestran las dos versiones para
que la persona elija. Nunca se fusiona ni se sobrescribe en silencio.

### 4. Borrado

Propuesta:
- borrar en el servidor solo tras confirmación, nombrando la libreta;
- sin papelera local en la primera entrega;
- un contacto que el servidor ya no tiene se trata como borrado, no como
  error.

### 5. Duplicados

#41 exige que enlazar duplicados sea revisable y no borre nada remoto.
Propuesta: un enlace local entre contactos, mostrado como una sola persona y
deshacible, sin escribir nada en el servidor.

### 6. Importar y exportar vCard

Propuesta:
- **Importar** solo a la libreta local o a una CardDAV editable, con vista
  previa y límite de tamaño, y descartando las tarjetas sin nombre ni correo
  (`Person::is_useful`).
- **Exportar** lo que se ve, con su origen en un campo `X-` de la tarjeta.

### 7. Fotos

Hoy la foto viaja con la tarjeta. Propuesta:
- no descargar nunca fotos por URL remota, porque harían de píxel de rastreo;
- conservar solo las fotos incrustadas, con un límite de tamaño;
- al exportar, incluir la foto solo si se pide.

## Orden propuesto tras aprobar

1. Migración: columna de versión en `people`, rellenada en la próxima
   sincronización.
2. Libreta local con alta, edición y borrado (N1/N2).
3. CardDAV con ETag contra Radicale: conflicto, permiso revocado, tarjeta
   mal formada e interrupción (N3).
4. Duplicados y vCard.
5. Google y Exchange, cuando se cumplan sus condiciones.
