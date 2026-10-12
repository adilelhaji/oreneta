# ADR-0033: Compartir archivos por enlace desde almacenamiento en la nube

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Sin servicio nuevo de pago.
- Fecha: 2026-10-12.
- Alcance: #108.

## Decisión

- **Proveedores ahora:**
  - Nextcloud y ownCloud, con WebDAV para subir y la API OCS para el
    enlace;
  - una contraseña de aplicación, guardada en el llavero del sistema y
    nunca en la base de datos;
  - solo HTTPS, salvo loopback para pruebas, y nunca se sigue una
    redirección con la contraseña;
  - vBoxxCloud, al ser Nextcloud, se usa como Nextcloud.
- **Proveedores bloqueados:**
  - Dropbox, OneDrive y Google Drive necesitan registros OAuth propios de
    Oreneta, que solo puede crear el propietario;
  - se muestran como «no disponibles todavía», no a medio hacer;
  - leitzcloud queda fuera hasta que haya documentación de su API.
- **Flujo:**
  - antes de subir, se ve el destino (servidor, carpeta y nombre; un nombre
    ocupado lleva número y nunca se sobrescribe);
  - también se ve lo que el enlace permitirá: solo ver, contraseña
    (activada por omisión y generada al azar) y caducidad (por omisión 7
    días, o el máximo del servidor);
  - lo que el servidor exige (contraseña o caducidad obligatoria, días
    máximos) se lee de sus capacidades y se aplica antes de crear nada;
  - la subida muestra progreso y se puede cancelar; cancelada o fallida,
    se borra lo subido;
  - al crear el enlace se lee lo que el servidor concedió. Si permite
    editar, no caduca cuando se pidió, cambia la fecha o pierde la
    contraseña, se retira y se dice;
  - el enlace se inserta en el mensaje solo al pulsar, con su caducidad; la
    contraseña no se pone en el mensaje;
  - un enlace hecho se puede retirar en lugar de insertarlo.
- **Errores:** contraseña revocada (401/403), almacenamiento lleno (507),
  cancelación y discrepancias de permisos tienen su propio mensaje.

## Pendiente

- Dropbox, OneDrive y Google Drive cuando existan los registros OAuth.
- N5: probar contra un Nextcloud real en la verificación final.
