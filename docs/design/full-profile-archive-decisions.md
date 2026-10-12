# Copia completa del perfil: decisiones pendientes (#171, #172, #173, #113)

Con fecha 2026-10-11. [ADR-0010](../adr/0010-full-profile-local-recovery.md)
decide el qué. Este documento recoge lo que el ADR no fija y hay que decidir
antes de escribir la captura. Cada punto lleva una propuesta; ninguna está
implementada.

## Estado de la rama

- **Copia actual.** La copia que existe es la de configuración de ADR-0008
  (`meron-core/src/backup.rs`): cuentas, ajustes, feeds y metadatos PGP/S/MIME.
  Su importación se fusiona sobre la base en uso; no hay restauración aislada.
- **Reutilizable con pruebas** (`backup/tests.rs`):
  - PBKDF2 con 600 000 iteraciones y AES-256-GCM con AAD fija;
  - rechazo de contraseña incorrecta, de texto cifrado manipulado, de versión
    futura y de parámetros de derivación absurdos.
- **Corregido el 2026-10-11.** Escribir una copia borraba la anterior antes de
  escribir la nueva. Ahora se escribe aparte y se renombra al terminar, y un
  fallo conserva la anterior intacta (`TestWritePrivateFileKeepsThePreviousBackupWhenTheWriteFails`).

## Decisiones

> **Resueltas el 2026-10-11 por delegación** en
> [ADR-0017](../adr/0017-profile-archive-format.md), que toma age para el
> cifrado en lugar de la composición propia del punto 1. Lo que sigue es la
> propuesta original, conservada como registro.

1. **Cifrado de perfiles grandes.**
   - AES-GCM de una sola pasada obliga a tener todo el archivo en memoria y a
     ponerle un tope.
   - Un perfil con años de correo supera con facilidad 1 GiB, así que hace
     falta cifrar por bloques: cada bloque autenticado con su índice y un
     indicador de último bloque, al estilo de la construcción STREAM.
   - Es una composición nueva sobre primitivas existentes. ADR-0010 pide
     reutilizar primitivas, no inventar construcciones. Necesita revisión
     criptográfica.
   - **Propuesta:** bloques de 1 MiB con AES-256-GCM, nonce = prefijo aleatorio
     de 7 bytes + contador de 32 bits + byte de último bloque; clave derivada
     con el PBKDF2 actual.
   - **Alternativa:** tope de 512 MiB y una sola pasada en la primera versión.
2. **Inventario.**
   - Entra: la base completa (correo en caché, borradores locales, intentos de
     envío, ajustes) y los medios en línea guardados.
   - **Propuesta:** la caché de adjuntos (`appCacheDir()/attachments`) se
     declara reconstruible y se excluye en el manifiesto.
   - Hay estado de la interfaz en `localStorage` de WebView, como
     `lib/sessionPref.ts`. **Propuesta:** se excluye y se declara.
   - El ADR prohíbe llamar «completa» a una copia con omisiones sin resolver.
     ¿Basta con declarar las exclusiones en el manifiesto?
3. **Secretos.**
   - Contraseñas del llavero, claves privadas PGP/S/MIME y concesiones de
     Graph del almacén del sistema.
   - **Propuesta:** fuera por defecto; dentro solo si la persona lo marca, en
     una sección aparte del archivo con el mismo cifrado.
   - Las concesiones de Graph no se copian nunca: se vuelve a iniciar sesión.
4. **Clave de la base restaurada (Windows).**
   - La copia lleva la base cifrada con una clave propia del archivo.
   - Al activar hay dos opciones: volver a cifrar la base con la clave del
     equipo, o guardar la clave del archivo en el Administrador de
     credenciales.
   - **Propuesta:** volver a cifrar con la clave del equipo. Así un perfil
     restaurado no depende del archivo.
5. **Límites y nombres.**
   - **Propuesta:** extensión `.oreneta-profile`, tamaño máximo de entrada
     declarado de 4 GiB, rutas relativas sin `..` ni unidades y espacio libre
     mínimo de 2× el tamaño.
6. **Copias programadas (#173).**
   - **Propuesta:** desactivadas por defecto, carpeta elegida por la persona y
     se conservan las 5 últimas. La última copia verificada no se borra nunca.

## Qué se puede hacer sin decidir

- Captura de la base en una transacción inmediata, con `sqlcipher_export`
  hacia una clave nueva.
- Verificación del archivo: integridad de SQLite, `user_version` no futura y
  validación de cada borrador.
- Restauración en un directorio aislado con diario de activación y
  recuperación tras interrupción.
- Pruebas de corrupción byte a byte, truncamiento, rutas maliciosas y
  escrituras concurrentes.

Todo eso depende del formato del contenedor (punto 1). Empezar sin decidirlo
obligaría a rehacer el formato.

## Necesita Windows nativo

- Renombrar el perfil con el sidecar o WebView2 abiertos.
- Interrupción y disco lleno reales.
- Ensayo de restauración sobre un candidato exacto
  (`windows-validation.yml`).
