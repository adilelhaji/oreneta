# Sincronización CardDAV completa o nada (#28)

## Problema reproducido

`fetch_book` devolvía lo que pudiera leer: una tarjeta con `GET` fallido se
saltaba, una respuesta `REPORT` sin `address-data` se ignoraba y un XML cortado
a mitad se analizaba hasta donde llegara. El llamador sustituía el libro local
por ese resultado (`replace_book`), así que un fallo parcial borraba contactos
en silencio mientras la sincronización figuraba como correcta (H02). Había un
test que fijaba ese comportamiento como deseado.

## Contrato

- **Todo o nada.** Leer un libro devuelve el libro entero o un error que nombra
  cuántas tarjetas faltaron y la primera. Con error, el llamador no toca la
  copia local y guarda el motivo en `lastError`, que Ajustes > Contactos ya
  muestra en rojo.
- **Qué cuenta como incompleto:** respuesta de tarjeta sin `address-data` o con
  estado de error (incluido un `propstat` fallido seguido de otro correcto),
  `address-data` que no es un vCard, `GET` de tarjeta con estado ≥ 300,
  listado `PROPFIND` con estado ≥ 300, y cualquier `multistatus` mal formado o
  sin su cierre (`parse_multistatus_complete`).
- **Libro vacío válido:** un `multistatus` completo sin tarjetas es un éxito
  vacío, sin segunda petición.
- **Borrados reales:** un contacto eliminado en el servidor desaparece en la
  siguiente sincronización completa; la política no congela el libro.

## Credenciales

Cada petición lleva la contraseña, así que seguir un `href` del servidor es
entregarla donde apunte.

- `credentials_may_follow`: nunca de HTTPS a HTTP; a otro host solo por HTTPS
  (proveedores que reparten DAV entre hosts, como las particiones de iCloud);
  un servidor HTTP local solo conserva su propio origen.
- En el descubrimiento, un `href` de principal o de home-set que no pasa esa
  regla cuenta como paso sin resultado y su motivo se informa; un libro en un
  origen no permitido no se ofrece.
- Al leer un libro, las tarjetas solo se piden al mismo origen del libro. Un
  `href` a otro servidor detiene la lectura sin enviar nada allí.
- `UreqTransport` fija `RedirectAuthHeaders::Never`: la contraseña nunca se
  reenvía en una redirección (era el valor por defecto de ureq; ahora explícito).

## Coste aceptado

Una tarjeta rota de forma permanente en el servidor impide actualizar ese libro
hasta que se corrija. El error dice cuál es. Es preferible a perder contactos
sin aviso; una fusión por elemento con tarjetas fallidas preservadas sería una
mejora posterior, no necesaria para los criterios de #28.

## Verificación

- Rust (`carddav::client_tests`): tarjeta que no llega, tarjeta con estado 500,
  `propstat` 403 seguido de 200, XML cortado, vCard inválido, libro vacío sin
  segunda petición, el libro listándose a sí mismo, tarjeta en otro host sin
  petición enviada, reglas de origen y descubrimiento sin bajar a HTTP.
- Integración con Radicale (`TestIntegrationContacts`): descubrimiento, lectura,
  cambio, borrado real recogido, contraseña rechazada y servidor caído con
  contactos conservados.
- No cubierto: redirecciones reales entre orígenes contra un servidor (la regla
  de ureq se fija en código, no se prueba con red) y proveedores reales.
