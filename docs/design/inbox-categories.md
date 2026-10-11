# Categorías de bandeja (#91, ADR-0023)

## Uso

En **Ajustes → Categorías de bandeja** se crean categorías con nombre,
color y, opcionalmente, condiciones. Cada condición compara el remitente,
los destinatarios o el asunto. Una categoría puede tomar el correo si se
cumple cualquier condición o solo si se cumplen todas. El orden de la lista
es el orden en que se prueban.

En la bandeja de entrada aparecen las pestañas **Todo**, una por categoría y
**Otros**, cada una con su recuento.

El menú contextual de una conversación dice en qué categoría está y por qué,
y ofrece:
- moverla a otra categoría;
- poner siempre el correo de ese remitente en la categoría actual;
- devolver la decisión a las reglas.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `categories/tests.rs` | Reglas en orden y lo demás en Otros; nada queda fuera de las pestañas; condiciones que se cumplieron; correcciones de conversación antes que de remitente; correcciones a categorías borradas ignoradas o eliminadas; supervivencia a una nueva descarga del servidor; aislamiento por cuenta; recuentos con no leídos y cobertura; validación; borrado de cuenta |
| N1 `store` | Migración 45 y versión de esquema |
| N2 `Categories.test.tsx` | Pestañas con recuentos y cobertura; faceta compatible con otros filtros; faceta quitada si la categoría ya no existe o fuera de la bandeja; motivo legible y corrección; deshacer una corrección de remitente; nada fuera de la bandeja; editor que rechaza nombres repetidos y condiciones vacías |
| N3 e2e | Auditoría axe del buzón con pestañas en temas claro y oscuro |
