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

## Siguiente

Paso 2 de ADR-0012: CardDAV con ETag contra Radicale.
