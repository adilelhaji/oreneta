# Envíos personalizados (#90, ADR-0026)

## Uso

Paleta de órdenes → **Envío personalizado…**:
1. Se eligen la cuenta, los destinatarios, el asunto y el texto, con
   marcadores como `{{to.firstName}}` o el nombre de cualquier columna.
2. **Previsualizar cada mensaje** muestra todos los mensajes tal como
   saldrán y lo que hay que corregir, con su línea.
3. **Enviar N mensajes** pide confirmación. Cualquier cambio obliga a
   revisar otra vez.

Después se ve el estado de cada destinatario, con **Detener**, **Seguir** y
**Reintentar los rechazados**.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `merge/tests.rs` | Lista y tabla con comillas; cada mensaje solo con sus datos; problemas por destinatario (repetido, dirección, falta un valor) y del envío (marcador desconocido, sin destinatarios, sin asunto, más de 500); el envío es lo revisado o nada; un Message-ID por mensaje; resultado por mensaje; pausa ante un rechazo temporal; reanudar sin repetir los inciertos; reintentar solo los rechazados; detener; reinicio resuelto por el intento de #29; rechazo temporal frente a rechazo; borrado de cuenta |
| N1 `main.rs` | Respuesta del envío → estado del mensaje |
| N2 `Merge.test.tsx` | Vista previa de cada mensaje antes de poder enviar; se envía exactamente lo revisado; estado por destinatario y motivo de la pausa; problemas marcados que impiden enviar; un cambio obliga a revisar otra vez |
