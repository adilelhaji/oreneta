# ADR-0028: Remitentes bloqueados y permitidos; ejecutar reglas tal como se previsualizaron

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-12.
- Alcance: lo que faltaba de #50 tras ADR-0005.

## Decisión

- **Listas por cuenta (`sender_lists`):**
  - por dirección o por dominio (`@dominio`); la dirección cuenta antes que
    su dominio, así que se puede permitir a una persona de un dominio
    bloqueado y al revés;
  - un remitente bloqueado se marca como spam con el motivo «lo bloqueaste»;
  - uno permitido nunca se marca, y eso pesa más que todo lo aprendido;
  - **sigue siendo solo una sugerencia:** nada se mueve sin que la persona
    actúe, como pide ADR-0005; mover automáticamente es cosa de una regla,
    que la persona escribe y ve;
  - cambiar una lista vuelve a juzgar al momento los mensajes que ya están
    en el equipo;
  - al borrar una cuenta se borran sus listas.
- **Lo que se ve es lo que se hace:**
  - el plan de una regla hace primero las marcas y después el único
    movimiento;
  - antes, una acción que iba detrás de «mover» salía en la vista previa y
    nunca se hacía, porque el mensaje ya no estaba donde se buscaba;
  - un segundo movimiento no podría hacerse y no se planifica.
- **Ejecutar sobre el correo que ya hay:**
  - la vista previa de las reglas guardadas entrega una revisión de un solo
    uso, ligada a la cuenta, la carpeta, su UIDVALIDITY y la huella de las
    reglas (como el barrido de #27);
  - ejecutar hace exactamente esos pasos sobre exactamente esos mensajes;
  - cualquier cambio obliga a previsualizar otra vez;
  - cada paso queda en el registro de reglas, y el informe dice qué falló y
    por qué;
  - un fallo detiene los pasos de ese mensaje, no los de los demás.

## Pendiente

- Validación con proveedores reales (N5).
