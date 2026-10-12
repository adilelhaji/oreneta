# ADR-0016: Perfiles aislados

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-11.
- Alcance: primera entrega de #99.

## Inventario previo

Había un único juego de datos por instalación:
- la base cifrada y el registro en `<config>/oreneta`;
- la caché de adjuntos en `<cache>/oreneta`;
- los secretos en el llavero bajo el servicio `meron`, con entradas por
  cuenta y una de nombre fijo para la clave de la base;
- los borradores abiertos y las cachés de tema, letra e idioma en el
  `localStorage` del webview, compartido por todo lo que se abra en el
  equipo.

No existían perfiles ni grupos de cuentas.

## Alternativas

1. **Un proceso y una ventana por perfil (elegida).** Cada perfil tiene su
   carpeta, su caché, sus entradas de llavero y su bloqueo de instancia
   única. Abrir otro perfil lanza la aplicación con `--profile=<id>`; si ya
   está abierto, se trae al frente.
2. **Cambiar de perfil dentro del mismo proceso.** Exige vaciar toda la
   memoria del puente, del núcleo y de la interfaz (búsquedas,
   notificaciones, colas de envío) sin dejarse nada. Un olvido mezclaría
   datos, y es justo lo que la issue prohíbe.
3. **Reiniciar la aplicación al cambiar.** Es más seguro que la opción 2,
   pero cierra el trabajo sin guardar del perfil que se deja.

## Decisión

- La instalación existente es el perfil `default` y conserva sus rutas y
  nombres de llavero: no hay migración.
- Los demás perfiles viven en `profiles/<id>` dentro de las carpetas de
  configuración y caché. Sus entradas de llavero se llaman
  `profile:<id>/<nombre>`, de modo que dos perfiles con la misma cuenta no
  comparten secretos ni clave de base.
- El binario del núcleo y las actualizaciones descargadas son de la
  instalación, no del perfil.
- El puente escribe el perfil en la página
  (`<meta name="oreneta-profile">`) antes de que corra ningún script. La
  página usa claves de `localStorage` propias de cada perfil; el perfil por
  defecto mantiene las suyas.
- La lista de perfiles es un archivo JSON escrito de forma atómica. Si está
  dañada se informa y no se reescribe; se abre el perfil por defecto. Un
  perfil desconocido o mal formado en la línea de órdenes también abre el
  perfil por defecto, sin crear uno vacío.
- Solo se borra desde fuera un perfil que nunca se abrió: el que tiene datos
  guarda secretos en el llavero que solo se encuentran desde dentro.

## Pendiente

- Borrar un perfil con datos, desde dentro, quitando antes sus cuentas.
- Grupos de cuentas e inclusión explícita en las carpetas globales.
- Verificación nativa (N4) en Windows: dos perfiles abiertos a la vez, el
  llavero de Windows con nombres de perfil y la ventana correcta al frente.
