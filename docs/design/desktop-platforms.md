# Plataformas de escritorio: Linux y macOS (#115)

Lo que se comprueba en cada plataforma, y lo que no.

- **Comprobación:** `scripts/test-desktop-startup.sh` abre dos veces el
  binario de producción en un perfil nuevo. En cada arranque espera dos
  cosas en el registro:
  - que el núcleo haya arrancado;
  - que la aplicación React dentro del webview le haya hecho sus primeras
    llamadas, con la CSP de producción.

  Guarda una captura y el registro de cada arranque. Falla si el núcleo no
  arranca o si la aplicación muestra su pantalla de error.
- **Linux:** WebKitGTK 4.1 bajo Xvfb, en el trabajo `linux-native` de CI.
  También pasa en local.
- **macOS:** WKWebView en el runner alojado de GitHub, en el trabajo
  `macos-native`. El repositorio es público, así que esos minutos no
  cuestan nada.

## Lo que no cubre

Arrancar no es paridad. En macOS siguen sin evidencia:

- el llavero del sistema (la comprobación usa `MERON_KEYRING=off`);
- las notificaciones;
- la impresión;
- los métodos de entrada (IME);
- la instalación firmada y la actualización;
- un flujo de correo con una cuenta real.

Esa evidencia necesita un Mac con sesión de usuario, la firma y la
notarización de Apple y cuentas de prueba. Todo eso depende del
propietario, igual que la verificación nativa de Windows. Linux sigue siendo
una plataforma con regresión comprobada; su resultado no prueba nada sobre
la paridad en macOS o en Windows.
