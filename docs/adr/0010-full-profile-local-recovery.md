# ADR-0010: Copia completa local cifrada de un perfil

- Estado: aceptada.
- Fecha: 2026-10-05.
- Alcance: #146, #113 y durabilidad de borradores de #39.
- Aprobación humana: «Sí, implementar copia completa local cifrada», en respuesta
  a la opción B de [la propuesta](../design/profile-recovery-options.md), que
  incluye borradores y archivos.
- Sustituye exclusivamente el límite de configuración del punto 2 de ADR-0008.
  Diagnósticos locales y actualizaciones confirmadas mantienen su contrato.

## Decisión

Conservar la exportación de configuración como opción independiente y añadir una
copia manual local cifrada del perfil persistido. Primero hacer durables los
borradores completos y sus archivos. Una captura no se presenta como completa
si hay datos pendientes de persistir, archivos omitidos o errores sin resolver.

La captura coordina las escrituras de base y archivos; no copia una base viva a
ciegas. El archivo tiene formato versionado, manifiesto y límites de tamaño y
rutas. Su cifrado es obligatorio y reutiliza primitivas existentes. La contraseña
no se incluye en la copia. La recuperación debe funcionar con archivo y contraseña
sin el llavero original: la clave necesaria para abrir la base se distingue de
credenciales y claves privadas opcionales. El manifiesto declara sus exclusiones.

La restauración se valida en una ubicación aislada antes de una activación
explícita y reversible. Contraseña incorrecta, corrupción, incompatibilidad,
interrupción o falta de espacio conservan el perfil original. El perfil recuperado
queda sin sincronización hasta una reconexión y reconciliación explícitas. Nunca
se reenvían automáticamente mensajes, invitaciones ni escrituras pendientes o de
resultado incierto.

Compatibilidad inicial Windows y formatos/esquemas expresamente soportados;
rechazar formatos futuros sin modificar el destino. No implica portabilidad a
móvil ni gestión simultánea de varios perfiles. Programación y retención son
posteriores, desactivadas por defecto, con límites visibles y protección de la
última copia validada. No se autorizan nube, publicación ni gasto adicional.

## Entregas y límites de evidencia

1. Durabilidad de borradores y archivos: almacén #169 e integración del editor
   y respuestas rápidas #170, con revisión de concurrencia y errores.
2. Captura consistente, cifrado y verificación del archivo: #171.
3. Restauración aislada, activación reversible e interrupciones: #172.
4. Programación y retención explícitas: #173.

Cada entrega lleva tests, revisión técnica y de producto, y CI del commit
entregado. El archivo requiere espacio adicional y perder su contraseña impide
abrirlo. Las pruebas sintéticas no acreditan recuperación nativa ni interoperación
con proveedores. #113 permanece abierta hasta demostrar toda su aceptación.
