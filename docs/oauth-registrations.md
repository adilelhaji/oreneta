# Registros OAuth: inventario y configuraciones (#144)

Con fecha 2026-10-10. No contiene credenciales: los nombres de variable y los
ámbitos bastan para revisarlo.

## Inventario

| Cliente | Dónde vive | Propietario | Ámbitos |
|---|---|---|---|
| Google (Gmail, Calendar, Contactos) | `oauth_inherited.go`, ofuscado | Meron (Nonbili), heredado de la bifurcación | `https://mail.google.com/` (restringido), `userinfo.email` y `userinfo.profile`, `calendar` y `contacts.readonly` (sensibles) |
| Microsoft (Outlook IMAP/SMTP y Microsoft Graph) | `oauth_inherited.go`, ofuscado | No consta que sea de Oreneta: llegó con la bifurcación, sin historial propio | IMAP/SMTP: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid email profile`. Graph: `Mail.Read`; y, solo si se piden aparte (ADR-0004), `Mail.ReadWrite` y `Mail.Send` |
| Google o Microsoft propios de Oreneta | — | No existen todavía | — |

El responsable debe confirmar a quién pertenece el cliente de Microsoft. Hasta
entonces se trata como no propio.

## Configuraciones

### Desarrollo interno (compilación por defecto)

- Compila los valores heredados de `oauth_inherited.go`
  (`//go:build !distributable`).
- Para Google, `MERON_GOOGLE_CLIENT_ID` y `MERON_GOOGLE_CLIENT_SECRET` en el
  entorno tienen prioridad. Microsoft solo toma el valor compilado, por la
  decisión que fija `TestGoogleOAuthTakesCredentialsFromEnvironment`.
- No debe distribuirse: usa registros que no son de Oreneta.

### Distribuible (`-tags distributable`)

- No compila ningún valor heredado (`oauth_distributable.go`).
- Los valores propios se inyectan al compilar, ofuscados con
  `go run ./cmd/obfuscate`:

  ```sh
  wails build -tags "distributable …" -ldflags "-X main.googleClientIDObf=… -X main.googleClientSecretObf=… -X main.outlookClientIDObf=…"
  ```

- Sin un valor, o con uno mal formado, ese inicio de sesión no está disponible:
  - el asistente desactiva el botón y explica las alternativas;
  - Microsoft Graph se niega antes de abrir el navegador;
  - el núcleo no recibe ningún cliente y una cuenta OAuth que necesite renovar
    el token dice que el inicio de sesión no está disponible en esta
    compilación y propone añadir el buzón con contraseña.
- IMAP/SMTP con contraseña, Exchange (EWS) y las suscripciones de calendario
  no dependen de nada de esto.
- `release.yml` todavía no compila con `distributable`. Activarlo deja las
  versiones publicadas sin inicio de sesión con Google ni Microsoft hasta que
  existan registros propios. Es decisión del responsable, junto con crear esos
  registros.

### Forma válida

Un valor con otra forma cuenta como ausente, en las dos compilaciones:
- Google: `<número>-<id>.apps.googleusercontent.com`;
- secreto: sin espacios y de 256 caracteres como máximo;
- Microsoft: un GUID.

El entorno que se pasa al núcleo lleva solo los valores aceptados. Antes copiaba
las variables del proceso tal cual, de modo que el núcleo podía renovar tokens
con un cliente que el inicio de sesión había rechazado, o con un
`MERON_OUTLOOK_CLIENT_ID` que Go ignora a propósito.

## Requisitos de Google

- **Lo comprobado.** Comprobado el 2026-10-10 sobre el texto de
  [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
  (esta sesión no pudo abrir la página, solo su texto indexado):
  - los ámbitos de Gmail, incluido el uso por IMAP/SMTP, son restringidos;
  - una app que guarda o transmite datos de ámbitos restringidos en servidores
    necesita una evaluación de seguridad;
  - las excepciones publicadas a la verificación son: uso personal, entornos
    de desarrollo, solo datos propios del servicio, uso interno de una
    organización e instalación en todo un dominio.
- **Pendiente de confirmar.** Oreneta guarda el correo solo en el dispositivo.
  No he confirmado en la documentación oficial si eso exime de la evaluación;
  solo hay indicios de terceros. El responsable debe confirmarlo antes de
  decidir. No se ha asumido que haga falta una evaluación de pago ni que no
  haga falta.
- **Bloqueado hasta autorización expresa:** crear registros, enviar a
  verificación o pagar una evaluación.

## Pruebas

- **Go, ambas compilaciones** (`oauth_config_test.go`): los valores mal
  formados no cuentan como configurados, el inicio de sesión los rechaza y no
  llegan al núcleo.
- **Go, desarrollo** (`oauth_inherited_test.go`): el entorno manda para Google,
  se usan los valores compilados si no hay entorno, y el núcleo recibe solo el
  cliente de Microsoft de la compilación.
- **Go, distribuible** (`oauth_distributable_test.go`):
  - sin valores inyectados se niegan Gmail, Outlook, el canje de código y
    Graph, y el núcleo no recibe nada;
  - con valores inyectados se usan esos.
- **Rust** (`engine::tests::refresh_fails_closed_without_an_oauth_client`):
  - sin cliente, también con una variable vacía, la renovación se detiene con
    el motivo;
  - prioridad: el de la cuenta, luego el del anfitrión, luego el del entorno.
- **CI** (trabajo `go`):
  - compila el binario distribuible;
  - `scripts/ci/inherited-oauth.cjs` comprueba que no contiene ninguno de los
    valores de `oauth_inherited.go` e informa solo de los nombres;
  - comprobado a mano en las dos direcciones: el binario de desarrollo se
    señala y el distribuible no.
