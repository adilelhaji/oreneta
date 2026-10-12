# Enlaces a archivos en la nube (#108)

Registro de la implementación de ADR-0033.

## Piezas

- **Núcleo:**
  - `meron-core/src/cloud/` tiene las cuentas (`cloud_accounts`, esquema
    51, sin contraseña), las capacidades, la subida con progreso y
    cancelación, el enlace comprobado y su retirada;
  - RPC `cloud.providers/list/save/check/remove/upload/cancel/share/revoke`;
  - eventos `cloud.progress` y `cloud.uploaded`.
- **Puente Go:** `cloud.pickFile` elige el archivo con el diálogo nativo y
  pasa su ruta, y el núcleo lo lee del disco.
- **Aplicación:** grupo de Ajustes «Almacenamiento en la nube» y diálogo
  «Compartir un archivo por enlace» en el composer.

## Pruebas

Contra un servidor local que responde como Nextcloud:
- la contraseña no va en la tabla, solo hay proveedores usables y no se
  admiten HTTP ni rutas con `..`;
- las capacidades se leen bien;
- la subida va a su carpeta con un nombre libre y se codifica la ruta;
- una contraseña revocada y un almacenamiento lleno se dicen y se limpian;
- cancelar borra lo subido;
- el enlace es de solo lectura, con contraseña y caducidad leídas de
  vuelta;
- un enlace editable, sin caducidad o sin contraseña se retira;
- las exigencias del servidor se aplican antes de crear nada.

En la aplicación: destino y reglas del servidor, progreso, enlace final y
lo que permite, la contraseña fuera del mensaje, almacenamiento lleno y
enlace retirado. En Go: descripción del archivo elegido.
