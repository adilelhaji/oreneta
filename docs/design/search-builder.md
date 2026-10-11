# Constructor de búsquedas (#43, ADR-0021)

## Uso

El botón de ajustes junto a la caja de búsqueda abre **Opciones de
búsqueda** con lo escrito ya repartido en campos:
- palabras;
- remitente y destinatario (varios separados por comas, cualquiera de
  ellos);
- asunto y etiqueta;
- leído o no leído, destacados y con adjuntos;
- desde un día y antes de un día.

**Buscar** escribe la búsqueda en la caja con la sintaxis de siempre.

Una búsqueda guardada recuerda dónde se guardó, y al abrirla se vuelve a
esa cuenta y carpeta.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `search/tests.rs` | Ida y vuelta de un corpus (operadores, comillas, varios valores, fechas válidas e inválidas, URL con dos puntos, espacios); escritura estable; valores vacíos ignorados |
| N2 `SearchBuilder.test.tsx` | El constructor abre con la lectura del núcleo y escribe por el núcleo; días como los cuenta el núcleo; búsqueda guardada con ámbito que vuelve a su carpeta; compatibilidad con las guardadas antes |
