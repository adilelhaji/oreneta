# Listas de remitentes y ejecución revisada de reglas (#50, ADR-0028)

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `spam/tests.rs` | Bloqueado o permitido decide y lo dice, por encima de lo aprendido |
| N1 `store/tests.rs` | Patrones de dirección y dominio; la dirección antes que el dominio; por cuenta; los veredictos guardados cambian al momento; quitar de la lista |
| N1 `rules/tests.rs` | El plan es lo que se puede hacer: marcas primero y un solo movimiento (falla con el código anterior) |
| N1 `rules/run.rs` | La revisión es de un solo uso y solo si no cambiaron la cuenta, la carpeta, las reglas ni el tiempo |
| N2 `SpamAndRuns.test.tsx` | Bloquear, permitir y quitar por cuenta, con el error dicho; ejecutar las reglas guardadas tal como se previsualizaron e informar de cada paso fallido |

Al escribir la prueba de la interfaz apareció un defecto real: el estado de
la vista previa descartaba la revisión que devolvía el núcleo. Está
corregido.
