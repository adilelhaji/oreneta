# Reglas en el servidor (#94, ADR-0027)

## Uso

**Ajustes → Reglas → Reglas en el servidor**:
1. Se elige la cuenta y se pulsa **Comprobar el servidor**. Se ve:
   - cuántas reglas pueden ir;
   - cuáles se quedan aquí y por qué;
   - el script tal como se guardaría;
   - si la copia del servidor es la que escribió Oreneta.
2. **Aplicar en el servidor** pide confirmación.
3. **Quitarlas del servidor** devuelve las reglas a este equipo.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `rules/sieve/tests.rs` | Una regla, un bloque, con las marcas antes de archivar; lo que el servidor leería más amplio se queda entero; etiqueta enlazada como palabra clave; extensiones que faltan; solo reglas activas de la cuenta; comillas seguras; «no contiene» |
| N2 `rules/managesieve/tests.rs` (servidor simulado) | Capacidades y contraseña rechazada; escribe, activa y lee igual; no reemplaza una copia cambiada sin permiso; no apaga otro script activo; un script rechazado no se guarda; quitar desactiva primero |
| N1 `rules/server.rs` | Solo un script activo saca reglas del motor local, por cuenta |
| N2 `ServerRules.test.tsx` | Muestra lo que va y lo que se queda antes de enviar nada; no reemplaza sin permiso y luego sí; explica por qué una cuenta no puede |

La prueba contra un Dovecot real queda para la verificación final (N5).
