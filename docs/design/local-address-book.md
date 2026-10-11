# Libreta de contactos local (#41, ADR-0012, paso 1)

## Qué hace

- **Personas** tiene un botón «Nuevo contacto». Los contactos de la libreta
  local tienen «Editar» y «Eliminar». Los de libretas sincronizadas (CardDAV,
  Google, Exchange) siguen siendo de solo lectura y no muestran esos botones.
- Los contactos locales se guardan solo en este equipo, y el editor lo dice.
  No tienen cuenta, así que eliminar una cuenta no los toca (ADR-0011).
- Un contacto necesita nombre o correo. Las filas vacías no se guardan, y los
  correos se guardan en minúsculas, igual que los sincronizados.

## Versiones y conflictos

- `people.version` (migración 37) guarda la versión con la que se leyó cada
  contacto. Para la libreta local es un contador; para CardDAV será el ETag
  (paso 2).
- Editar o borrar exige la versión leída. Si no coincide, porque otra ventana
  lo cambió o lo borró, no se escribe nada y el núcleo devuelve la copia
  actual.
- El editor muestra entonces las dos versiones. «Conservar la mía» guarda
  sobre la versión actual. «Quedarme con la guardada» descarta los cambios.
  Si el contacto se borró, las opciones son «Crearlo de nuevo» o «Descartar».
- Borrar desde una versión antigua no borra nada y avisa.

## Órdenes del puente

- `people.save {id?, version?, person}`: crea o edita. Responde
  `{ok, id, version}` o `{conflict: true, current}`. Una edición sin versión se
  rechaza.
- `people.delete {id, version}`: borra. Responde lo mismo.
- `people.list` añade `version` y `editable` a cada contacto.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 almacén (`store/local_people/tests.rs`) | Alta y limpieza de campos; edición que avanza la versión; edición desde una versión antigua (no escribe y devuelve la copia actual); edición de un contacto borrado; borrado desde una versión antigua; rechazo de contactos vacíos; un contacto sincronizado no se puede escribir por esta vía |
| N1 despachador (`main.rs`) | Alta, listado con `editable`, conflicto entre dos ventanas, edición sin versión y borrado |
| Go (`people_write_test.go`) | Sin núcleo en marcha, una escritura falla en vez de fingir que guardó |
| N2 vista (`PersonEditor.test.tsx`) | Alta desde la cabecera; botones solo en contactos editables; conflicto: se ven las dos copias y «Conservar la mía» guarda sobre la versión actual; «Descartar» no escribe |

## Paso 2: libretas CardDAV

### Qué se puede hacer

Los contactos de una libreta CardDAV se pueden editar y borrar, y al crear un
contacto se elige «Este equipo» o una libreta CardDAV editable. El editor dice
dónde se guarda el cambio. Al borrar un contacto de servidor, el aviso recuerda
que desaparece para todas las apps que leen esa libreta. Google y Exchange
siguen siendo de solo lectura (ADR-0012).

### Qué guarda la sincronización

- De cada tarjeta: su URL (`people.href`, migración 38) y su ETag
  (`people.version`).
- De cada libreta: si el servidor deja escribir en ella, según
  `current-user-privilege-set` (`contact_sources.writable`). Si el servidor
  dice que no, no se ofrece editar. Si no dice nada, se permite editar y un
  rechazo del servidor se muestra.

### Cómo se escribe

- **Editar.** Se lee la tarjeta actual. Si su ETag no es el que se leyó, no
  se escribe nada y se devuelve la copia del servidor. Si coincide, se
  modifica la tarjeta del servidor y se envía con `If-Match`. Un `412` entre
  la lectura y la escritura también es un conflicto.
- **Solo cambian las líneas tocadas** (`contacts::vcard_write`). Se conserva
  todo lo que la app no muestra: direcciones, cumpleaños, foto, UID, campos
  propios de otros clientes y la etiqueta de Apple que va con cada correo.
  - Un correo o teléfono que sigue igual conserva su línea original.
  - Al cambiar el nombre se reescriben `FN` y `N`. `N` lleva el nombre entero
    como nombre de pila, sin adivinar apellidos.
- **Crear.** Se envía una tarjeta vCard 3.0 nueva con `If-None-Match: *`. Si
  el servidor no devuelve el ETag, se vuelve a leer la tarjeta.
- **Borrar.** Se envía `DELETE` con `If-Match`.
- **Nunca se escribe sin versión conocida** ni en otro servidor que el de la
  libreta: la contraseña no sale de ahí (#28).

### Corrección encontrada por el camino

`ORG` se cortaba en un `;` escapado: «Acme\; Ltd» se leía «Acme». Ahora se
separa solo por `;` sin escapar, igual que `N`.

### Pruebas del paso 2

| Nivel | Qué cubre |
|---|---|
| N1 (`contacts/vcard_write_tests.rs`) | Una tarjeta de Apple editada conserva ADR, BDAY, foto, UID y etiquetas; quitar un correo quita su etiqueta; renombrar; números con distinto espaciado; tarjeta nueva de ida y vuelta; líneas plegadas sin partir caracteres |
| N1 (`carddav/write_tests.rs`, servidor falso con estado) | `If-Match` correcto; conflicto sin escritura; «Conservar la mía»; tarjeta borrada en el servidor; alta con `If-None-Match` y ETag leído de nuevo; borrado desde una versión antigua; nada se envía a otro servidor; nunca se escribe sin versión |
| N1 (`carddav/client_tests.rs`) | Permisos: lectura sola, `write`, `all` y sin respuesta |
| N3 (`integration_contact_writes_test.go`, Radicale 3.5.4) | Editar conservando BDAY y ADR; cambio en el servidor → conflicto sin escritura, y «Conservar la mía» después; alta en la libreta; borrado desde una versión antigua rechazado, y después correcto |
| N2 (`PersonEditor.test.tsx`) | Elegir libreta al crear; editar un contacto de servidor con su versión, indicando dónde se guarda |

La prueba N3 se ejecutó en local contra Radicale 3.5.4 instalado aquí, en
lugar de Docker. En CI se ejecuta con la imagen Docker del arnés.

## Siguiente

- Duplicados, importación y exportación de vCard, y fotos (ADR-0012 punto 5).
- Google y Exchange, cuando se cumplan sus condiciones.
