# Almacén de borradores locales (#169)

Contrato de implementación bajo [ADR-0010](../adr/0010-full-profile-local-recovery.md).
Esta entrega prepara el almacén; la conexión al editor, migración de localStorage,
imágenes insertadas y respuestas rápidas corresponde a #170. No entrega todavía
recuperación del editor ni una copia completa.

## Documento y confirmación

Un identificador local opaco y estable identifica el borrador, independientemente
de su Message-ID remoto. Un documento JSON versión 1 conserva identidad, cuenta,
destinatarios, asunto, cuerpos y adjuntos con sus bytes base64 y metadatos. Los
campos adicionales se conservan. No se sustituye un adjunto por su ruta temporal.
Referencias a imágenes del caché requieren captura de bytes en #170 antes de
declarar el borrador completo para una copia.

La base existente almacena documento y revisión juntos en una transacción. Usa
el cifrado de base existente; el modo de tests sin llavero sigue siendo sintético.
La confirmación se devuelve después del commit, con sincronización SQLite FULL
para esa escritura. Error de validación, cuota, espacio o escritura no sustituye
el documento previo. Un resultado incierto debe releerse; no se reintenta con una
revisión adivinada. Las pruebas de proceso no certifican fallo eléctrico físico.

## Concurrencia y ciclo de vida

Crear exige revisión esperada 0. Actualizar o descartar exige la revisión leída;
el commit incrementa la revisión y devuelve su valor. Un conflicto devuelve la
revisión vigente y si fue descartado, sin sobrescribir ni crear copias ocultas.
El cliente conserva sus cambios hasta resolverlo explícitamente (#170).

Descartar vacía el documento y mantiene un tombstone: ni creación ni actualización
tardía pueden resucitar ese identificador. No se purgan tombstones en esta entrega.
Descartar un identificador aún no guardado también crea tombstone para bloquear
su primera escritura tardía. Cada nuevo borrador usa un nuevo identificador.

Cambiar de cuenta se guarda junto al contenido mediante la misma revisión; no
copia el borrador entre cuentas. Eliminar una cuenta no elimina el borrador local:
se conserva para recuperar contenido, sin autorizar envío desde una identidad
ausente. Envío pendiente, fallido o incierto no descarta automáticamente nada.
Listar puede filtrar por cuenta; leer y modificar requieren el identificador
local completo. Ninguna operación toca proveedores, red ni colas de envío.

## Límites y lectura

Identificador: 1–128 caracteres ASCII alfanuméricos, guion o subrayado. Documento
serializado: hasta 64 MiB; cuerpos HTML y texto: hasta 8 MiB cada uno; campos de
cabecera: hasta 64 KiB; hasta 64 adjuntos y 40 MiB de bytes adjuntos en conjunto.
Se valida base64 y tamaño declarado exacto, IDs de adjunto únicos, MIME y nombre
acotados. Máximo 256 borradores activos; tombstones no cuentan como activos.
No se trunca ni se elimina automáticamente contenido para cumplir esos límites.
El transporte del núcleo admite respuestas hasta 65 MiB para el documento de
64 MiB y su envoltorio. Un fallo de lectura o exceso del límite rechaza las
peticiones pendientes explícitamente, sin registrar el contenido recibido.
También invalida el transporte y detiene su proceso; las siguientes peticiones
fallan sin escribir. Se requiere reiniciar la aplicación para abrir otro núcleo.

Los listados devuelven solo identificador/cuenta/revisión/fecha, no todos los
bytes. Leer devuelve un documento validado o error explícito; datos corruptos y
versiones futuras nunca se convierten silenciosamente en un borrador vacío.
#170 debe mostrar fallos/conflictos, conservar la copia legacy hasta confirmar
la migración y detener captura completa si hay escrituras sin confirmar.

## Validación requerida

Migración idempotente sin pérdida; reapertura de texto, identidad y adjuntos;
conflictos entre conexiones; descarte frente a primera escritura tardía;
cambio/ausencia de cuenta; límites, formato futuro, corrupción; rollback ante
fallo y base de solo lectura. Revisión técnica/producto y CI del commit exacto.
La activación de este almacén en el editor y aceptación nativa siguen pendientes.
