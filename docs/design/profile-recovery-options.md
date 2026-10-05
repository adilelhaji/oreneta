# Recuperación del perfil: decisión pendiente (#146)

Estado: propuesta, **no aprobada**. Fecha: 2026-10-05. Base de recuperación
inspeccionada: `c40ea260f65b350bc1b5db7ddebb5f514fa0bcbb`; las columnas posteriores
usan la tabla de ajustes existente y no cambian el formato de copia.

ADR 0008 autoriza copias de configuración. #113 pide copia completa programada;
no son la misma capacidad. Se necesita una decisión humana antes de ampliar
formato, captura o restauración. Ninguna opción autoriza publicación ni servicios
externos. La revisión se limita a código y datos sintéticos, sin abrir perfiles
del usuario.

## Inventario y pérdida que la copia actual no resuelve

| Dato | Situación actual | Recuperación desde proveedor |
|---|---|---|
| Cuentas, preferencias por cuenta, ajustes globales y suscripciones RSS | Incluidos en `BackupData`; ajustes nuevos como `mailbox_views` también | Configuración local no deducible por completo del proveedor |
| Contraseñas y tokens del almacén de cuentas tradicional | Solo con opción de secretos y contraseña de cifrado; almacén seguro separado en escritorio. Secretos ausentes/ilegibles pueden omitirse aunque se soliciten | Reautenticación puede regenerar sesiones; no garantiza recuperar contraseñas antiguas |
| Autorizaciones y perfiles Graph | El vault y las tablas de perfiles Graph no forman parte del payload actual, tampoco por marcar secretos | Reautorización y reconstrucción requieren verificación; no afirmar que la copia restablece Graph |
| Identidades OpenPGP y S/MIME | Metadatos incluidos; claves privadas solo con secretos/cifrado y si están disponibles | No se pueden reconstruir las claves privadas desde correo remoto |
| Confianza/certificados ajenos | Tablas `pgp_certs`/`smime_certs`, fuera de `BackupData` | No asumir reconstrucción de decisiones locales de confianza |
| Correo y estado de sincronización | Tablas de mensajes/carpetas, excluidas | IMAP/EWS/Graph permiten volver a consultar lo que conserve el servidor y autorice la cuenta; no acredita recuperar correo eliminado, datos solo locales ni una instantánea histórica |
| RSS descargado | La copia conserva suscripciones, no artículos | El feed puede dejar de publicar artículos antiguos |
| Borradores del editor completo | Texto en `localStorage` (`meron-compose-tabs`), fuera de la copia; adjuntos se excluyen de esa persistencia | Solo una copia guardada efectivamente en Drafts podrá recuperarse del servidor |
| Respuesta rápida | Estado del editor y guardado remoto explícito/automático por su flujo actual | Un guardado pendiente o fallido no es una copia remota confirmada |
| Adjuntos y contenido insertado | Archivos bajo el directorio de medios/caché, más adjuntos del editor; fuera de `BackupData` | Recuperables solo si siguen en un mensaje remoto accesible; los archivos locales pendientes pueden no tener equivalente |
| Tareas vinculadas | Tabla `tasks`, excluida | Locales: no hay reconstrucción garantizada por proveedor |
| Etiquetas y asociaciones | `labels`, `thread_labels`, `label_links`, excluidas | Algunas asociaciones remotas pueden volver; etiquetas/anotaciones locales no se deducen de ellas |
| Reglas, plantillas, aprendizaje spam y prioridad | Tablas propias, excluidas | Estado local no reconstruible por correo remoto |
| Envíos programados y posposiciones | `scheduled_sends`/`snoozed_threads`, excluidos | Restaurar una programación no debe reenviar automáticamente; resultados inciertos requieren revisión |
| Personas y fuentes de contactos | `people`, emails/teléfonos y `contact_sources`, excluidos | CardDAV solo puede devolver contactos remotos confirmados y aún accesibles; no cambios locales pendientes |
| Calendarios y eventos | Tablas propias, excluidas | Depende del proveedor y de que los cambios estén confirmados; suscripciones no equivalen a datos locales recuperables |

Fuentes: [payload y aplicación de copias](../../meron-core/src/backup.rs),
[esquema local](../../meron-core/src/store/db.rs),
[borradores del editor](../../frontend/src/states/compose.ts),
[medios y caché](../../paths.go). No se ha certificado la reconstrucción real
para ningún proveedor en esta tarea; esa evidencia corresponde a #145/#98.
La afirmación general del comentario de `backup.rs` de que los mensajes son
reproducibles no cubre los casos locales, eliminados o no confirmados anteriores.

## Opciones para aprobar

**A. Mantener exclusivamente la copia de configuración.** Conservar ADR 0008 y
mejorar los avisos sobre exclusiones. Menor coste de implementación y archivos
pequeños; sigue siendo necesario volver a autenticar y sincronizar. Las pérdidas
locales descritas no quedan resueltas y #113 permanece como brecha de paridad.
No introducir programación de copias completas ni prometer recuperación integral.

**B. Añadir copia completa local cifrada de un perfil (recomendada).** Mantener
la exportación de configuración existente como opción independiente. Aprobar el
siguiente límite arquitectónico antes de diseñar/implementar las entregas:

- Captura consistente del perfil persistido, incluyendo base local, borradores
  y archivos necesarios. Primero garantizar borradores/adjuntos durables (#39);
  no llamar «completa» a una copia que omita datos locales pendientes. Coordinar
  la captura con las escrituras; nunca copiar a ciegas una base y sus archivos
  mientras cambian.
- Archivo versionado, con manifiesto de contenido y límites de tamaño/rutas;
  cifrado obligatorio por contener correo y datos personales. Reutilizar las
  primitivas criptográficas existentes cuando sirvan; no inventar criptografía.
  La contraseña de la copia no se guarda dentro. Secretos y claves privadas
  siguen siendo una inclusión explícita; el manifiesto declara sus exclusiones
  y la necesidad de volver a autenticar.
- La base local cifrada no puede depender del antiguo llavero para abrir la
  copia: recuperación con archivo y contraseña aun perdiendo el equipo original.
  La clave de almacenamiento necesaria para recuperar datos se distingue de las
  credenciales opcionales del proveedor. La técnica de exportación/recifrado se
  diseña y revisa en su entrega; no se presupone que copiar SQLCipher baste.
- Restaurar y verificar primero en una ubicación aislada; no sobrescribir el
  perfil activo durante la lectura/validación. Fallos de formato, contraseña,
  integridad, espacio o compatibilidad conservan el original. Activación local
  explícita y reversible; la sincronización queda detenida hasta una reconexión
  y reconciliación explícita con efectos visibles. Restaurar evidencia local no
  propaga estado antiguo al servidor: no envía correo, invitaciones ni repite
  escrituras u operaciones pendientes automáticamente. No requiere gestionar
  varios perfiles simultáneos de #99.
- Compatibilidad inicial Windows y una versión/esquema soportado explícitamente.
  No afirmar portabilidad de una base de escritorio hacia móvil. Formatos
  futuros se rechazan sin modificar el destino.
- Primera entrega manual local, sin nube ni borrado automático. La programación
  y retención se implementan en una entrega separada: no activadas por defecto,
  límites visibles y última copia validada protegida. No se eliminan archivos
  ajenos ni se amplía el gasto de infraestructura.

Coste B: requiere almacenamiento adicional del perfil y espacio temporal para
verificación/restauración, lectura de archivos grandes y coordinación entre
editor, núcleo y almacén seguro. Es mayor que A; no hay estimación fiable hasta
medir un perfil sintético representativo. Perder la contraseña impediría abrir
una copia cifrada; eso debe explicarse al crearla. Una copia no puede recuperar
datos que ya no existían ni convertir un envío incierto en un envío seguro.

## Evidencia existente y entregas posteriores

Las pruebas de `backup/tests.rs` cubren round-trip de configuración, ausencia
de correo cacheado, secretos opt-in, contraseña incorrecta, manipulación del
cifrado, formato futuro, límites KDF y fallo parcial con rollback de **SQLite**.
Ese rollback no demuestra reversión atómica del llavero externo. También hay
pruebas de errores y actualización de estado en `frontend/src/states/backup.test.ts`.
Se reutilizan; no justifican afirmar recuperación completa o nativa.

El 2026-10-05, la suite Rust de CI en `c06eff37` pasó (ejecución
37302492336, job 111738284833), incluyendo los 31 casos `backup::tests`.
El intento local focal de esos tests en Windows no llegó a ejecutarlos:
compilación E0463 por dependencias no encontradas en el entorno Rust local.
No se sustituye esa limitación por una afirmación de recuperación nativa.

Si se elige B, registrar primero el ADR que extiende solo el punto de backups de
ADR 0008. Separar: (1) durabilidad de borradores/archivos, (2) captura y verificación,
(3) restauración aislada/recuperación de interrupciones, (4) programación/retención.
Cada entrega necesita contrato concreto, tests sintéticos de éxito/errores/límites,
revisión y CI. La aceptación nativa y los ensayos por proveedor son posteriores.
Si se elige A, registrar la decisión y mantener explícitamente #113 incumplida.
