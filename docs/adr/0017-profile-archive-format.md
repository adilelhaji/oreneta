# ADR-0017: Formato de la copia completa del perfil

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-11.
- Alcance: decisiones 1 a 5 de
  [la lista pendiente](../design/full-profile-archive-decisions.md) para
  ADR-0010 (#171, #172). La 6 (copias programadas, #173) queda para su
  entrega.

## 1. Cifrado

Se descartan dos opciones:
- **Bloques AES-GCM propios.** Era la propuesta inicial, pero es una
  construcción nueva que ADR-0010 prohíbe sin revisión criptográfica.
- **Un tope de 512 MiB y una sola pasada.** Deja fuera los perfiles reales y
  exige tener todo el archivo en memoria.

**Decisión:** el formato [age](https://age-encryption.org/v1) con
contraseña, mediante el crate `age` 0.11.
- La clave se deriva con scrypt y el contenido se cifra con la construcción
  STREAM (ChaCha20-Poly1305 por bloques de 64 KiB, con un indicador de
  último bloque).
- Es un formato publicado, revisado y con implementaciones independientes.
  Escribe y lee en una pasada, sin límite de tamaño, y detecta el
  truncamiento.
- Coste de scrypt: N = 2^18 al escribir, fijo, para que un archivo hecho en
  un equipo rápido se abra en uno lento. Al leer se acepta como máximo
  N = 2^20, porque el coste viene del archivo antes de comprobar la
  contraseña.
- La contraseña tiene al menos 8 caracteres y no se guarda en ninguna parte.
- La dependencia solo se compila en escritorio.

## 2. Inventario

**Entra:**
- la base completa: correo en caché y archivo local, borradores con sus
  adjuntos, intentos de envío, contactos, tareas, notas y ajustes;
- las imágenes elegidas por la persona: avatares y fondos (`media/avatars`
  y `media/wallpapers`).

**No entra, y el manifiesto lo declara con su motivo:**
- la caché de adjuntos, que se vuelve a descargar;
- contraseñas, concesiones y claves privadas, que viven en el llavero;
- la disposición de la ventana y las pestañas abiertas (los borradores están
  en la base);
- el registro de diagnóstico.

Con las exclusiones declaradas, la copia se llama «completa del perfil» y la
interfaz enumera lo que queda fuera.

## 3. Secretos

No se incluyen en esta versión. Tras restaurar, cada cuenta se vuelve a
conectar, como ADR-0010 ya exige antes de sincronizar. Incluirlos de forma
opcional queda para una versión 2 del formato, en una sección aparte.

## 4. Clave de la base

- La base viaja exportada con una clave aleatoria propia del archivo,
  guardada en el manifiesto, dentro del flujo cifrado. Así el archivo se
  abre solo con su contraseña, sin el llavero original.
- Al restaurar se vuelve a cifrar con la clave del equipo, de modo que el
  perfil restaurado no depende del archivo.

## 5. Contenedor y límites

- Extensión: `.oreneta-profile`.
- Dentro del flujo cifrado van, por este orden:
  1. una línea mágica con la versión;
  2. las entradas (nombre, tamaño y bytes);
  3. el manifiesto, con formato, versión, fecha, versión de la aplicación,
     esquema, clave de la base, entradas con SHA-256 y exclusiones;
  4. una marca de fin.
- El manifiesto va al final para calcular el hash de cada entrada en una
  sola pasada.
- Límites:
  - 4 GiB por entrada y 200 000 entradas;
  - nombres canónicos de hasta 512 bytes, que solo pueden ser `db/meron.db`
    o estar bajo `media/`;
  - no se admiten `..`, `.`, separadores dobles, raíces, unidades ni barras
    invertidas, ni nombres repetidos.
- Se rechazan los archivos de una versión o un esquema más nuevos.
- La base restaurada debe pasar `PRAGMA integrity_check`.
- La copia se escribe en un `.part` que se renombra al terminar. La base
  solo se bloquea mientras se copia (`sqlcipher_export` en una sola
  sentencia), no mientras se empaqueta.

Falta la comprobación de espacio libre, que depende de la plataforma; se
mide en la verificación nativa (N4).

## Consecuencias

- El formato no se inventa y su seguridad descansa en age. Lo propio es el
  empaquetado interior, que se prueba con byte a byte cambiado, cortes,
  rutas maliciosas, nombres repetidos, manifiestos falsos y versiones
  futuras.
- Una copia ya escrita se puede comprobar sin tocar el perfil en uso.
