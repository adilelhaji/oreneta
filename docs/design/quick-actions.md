# Acciones rápidas (#92, ADR-0022)

## Uso

En **Ajustes → Acciones rápidas** se crea una acción con un nombre y sus
pasos: marcar leído o no leído, destacar o quitar el destacado, archivar o
mover a una carpeta (archivar y mover solo al final).

Con conversaciones seleccionadas, la barra de selección ofrece cada acción
con su atajo (Alt+1 … Alt+9). Se pide confirmación, y el informe dice qué
paso se hizo en cada conversación y dónde se paró si algo falló.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N2 `states/quickActions.test.ts` | Saneado de ajustes (nombre, pasos vacíos, demasiados, pasos desconocidos, mover sin carpeta, archivar antes del final); conjunto fijado al confirmar; cadena que se detiene en el fallo de una conversación sin parar las demás; informe con fallos |
| N2 `components/quick/QuickActions.test.tsx` | Editor que crea una acción y rechaza archivar antes del final; diálogo que confirma, ejecuta e informa de un fallo |
