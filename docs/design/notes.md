# Notas (#104, ADR-0015)

## Uso

El icono de nota de la barra lateral abre **Notas**: la lista a la izquierda
(fijadas primero, luego las más recientes) y la nota abierta a la derecha. Se
busca por título, texto y etiquetas (todas las palabras deben aparecer); las
etiquetas filtran con un clic. Una nota nueva se guarda en cuanto tiene algo
escrito, y cada cambio se guarda solo tras un instante. Al abrir otra nota no
se pierde lo pendiente.

Si la nota cambió en otra ventana, aparece un aviso con la versión guardada y
dos botones: **Mantener la mía** y **Usar la guardada**. Nada se sobrescribe
sin elegir.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`store/notes/tests.rs`) | Limpieza del HTML (scripts, manejadores, `javascript:`, imágenes remotas, `data:` fuera de `<img>`) y texto plano; revisión y conflicto; nota vacía, enorme o con demasiadas etiquetas; búsqueda por palabras con `%` literal; etiquetas sin distinguir mayúsculas; papelera, restauración, borrado definitivo sin etiquetas huérfanas y caducidad a 30 días |
| N1 despachador (`main.rs`) | Crear, listar con etiquetas, editar, conflicto, papelera, restaurar y borrar del todo |
| N2 (`NotesView.test.tsx`) | Crear al escribir y editar desde la revisión; conflicto con «Mantener la mía» y «Usar la guardada» sin escribir; papelera y restauración |
| N6 (`startup.e2e.ts`) | Auditoría axe de la vista con una nota abierta, en claro y oscuro |
