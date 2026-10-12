# Instalación de actualizaciones: verificación y vuelta atrás (#147)

Parte de #147 que se puede comprobar fuera de Windows. La instalación,
actualización y desinstalación reales en un Windows limpio siguen pendientes
de evidencia nativa.

## Qué se corrige

- **Verificación antes de instalar.** El SHA-256 y el tamaño se comprobaban
  solo al terminar la descarga. Después el paquete esperaba en la caché de
  actualizaciones, escribible por cualquier proceso del usuario, hasta que la
  persona pulsaba instalar. Ahora se vuelven a comprobar justo antes de
  sustituir la aplicación. Si el paquete ha cambiado, se ha ampliado o ha
  desaparecido:
  - se descarta;
  - la actualización vuelve a ofrecerse para descargar, con el motivo;
  - la aplicación instalada no se toca.
- **Ejecutable portable de Windows.** La sustitución está ahora en
  `update_portable.go`, sin etiqueta de plataforma. Solo `applyUpdate` y el
  relanzamiento siguen siendo de Windows. Antes de mover nada:
  - un archivo que no es zip se rechaza;
  - un zip sin `oreneta.exe` se rechaza;
  - una entrada que no empieza por la cabecera `MZ` se rechaza;
  - una entrada mayor que el límite de actualización (512 MiB) se rechaza,
    tanto por el tamaño declarado como por lo realmente leído.
- **Vuelta atrás.** Si el ejecutable nuevo no puede ocupar su sitio, se
  restaura el anterior. Si tampoco se puede restaurar, el error dice dónde ha
  quedado.

## Pruebas (cualquier plataforma)

- `TestUpdaterInstallRejectsAPayloadChangedAfterDownload` cubre un paquete
  alterado con el mismo tamaño, uno ampliado y uno borrado. Falla sin la
  corrección: el paquete alterado se instalaba.
- `TestReplaceExecutableRefusesABadArchive` cubre un archivo que no es zip, un
  zip sin ejecutable, un ejecutable que no es de Windows y una entrada vacía.
  En los cuatro casos el instalado sigue igual y no queda nada al lado.
- `TestReplaceExecutableSwapsInTheNewCopy` comprueba que la copia anterior
  queda como `.old` para el barrido al arrancar.
- `TestReplaceExecutableRestoresThePreviousCopyWhenTheSwapFails` simula un
  fallo del segundo renombrado.

## Pendiente (Windows nativo)

- Instalar, actualizar desde la versión anterior y desinstalar en un sistema
  limpio.
- Ejecutable bloqueado por otro proceso.
- Relanzamiento tras la actualización.
- Instalador NSIS en modo silencioso con UAC.
- Qué conserva la desinstalación: perfil en `%APPDATA%` y datos de WebView2.
