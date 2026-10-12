# ADR-0021: Constructor de búsquedas y búsquedas guardadas con ámbito

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #43.

## Contexto

La caja de búsqueda ya entiende operadores (`from:`, `to:`, `subject:`,
`is:`, `has:attachment`, `label:`, `after:`, `before:`). El núcleo los lee
una sola vez para el índice local, la búsqueda IMAP y la interfaz. Las
búsquedas guardadas solo guardaban el texto y se aplicaban a la carpeta que
estuviera abierta. #43 pide un constructor visual que conserve el
significado de cada operador, y vistas guardadas con su origen.

## Decisión

- **Constructor:** edita los campos de la consulta tal como los lee el
  núcleo (`search.parse`) y la vuelve a escribir con el núcleo
  (`search.compose`, el inverso de `parse`). Una prueba de ida y vuelta con
  un corpus fija que `parse(compose(q)) == q`, de modo que un constructor y
  la caja no pueden entender cosas distintas. Varios valores en un campo
  significan «cualquiera de ellos», como en la caja.
- **Ámbito de las búsquedas guardadas:**
  - una búsqueda guardada recuerda la cuenta y la carpeta donde se guardó,
    y abrirla vuelve allí;
  - las guardadas antes siguen funcionando donde se abran.
- **Vista viva:** una búsqueda guardada es una consulta, no una copia. La
  lista se actualiza con la sincronización y nunca mueve mensajes.

## Pendiente

- Combinar etiquetas con «todas» y «cualquiera»: el gramática solo admite
  una por búsqueda, y #13 fija el contrato del filtro rápido.
- Decir cuánto del servidor se ha consultado frente a lo que hay en el
  equipo.
