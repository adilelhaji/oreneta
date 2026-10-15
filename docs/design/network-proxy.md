# Proxy para todas las conexiones salientes

Qué conexiones usan el proxy de la aplicación, cómo, y qué no puede usarlo.

## Dónde vive el ajuste

- **Núcleo** (`meron-core/src/proxy.rs`): un proxy global en la tabla
  `settings` (clave `proxy`) y, por cuenta, una elección `ProxyChoice`:
  heredar el global (por defecto), conexión directa o un proxy propio.
  Tipos: HTTP CONNECT y SOCKS5; los nombres de host los resuelve siempre el
  proxy, nunca el resolvedor local.
- **RPC `proxy.route`** (`{account?}`): devuelve `{"proxy": null}` (directo)
  o `{"proxy": {mode, host, port, username, password}}`. Con cuenta sigue la
  elección de esa cuenta; una cuenta que aún no existe (se está añadiendo)
  hereda el global. Un proxy global activado pero incompleto (sin host o
  puerto) o con un modo desconocido es un **error**, no «sin proxy».

### Proxy elegido pero inutilizable (#192)

El núcleo nunca convierte un proxy elegido en una conexión directa:

- **Global.** El slot del proceso tiene cuatro estados: apagado, proxy,
  inutilizable (con el motivo) y no leído (con el motivo). Solo «nada
  guardado» y `mode` `"off"` o `""` son «apagado». Un modo con servidor o
  puerto vacíos, un puerto fuera de 1–65535, un modo desconocido o un valor
  que no se puede leer como ajuste (no es un objeto, `mode` no es texto) son
  «inutilizable». `publish_global` lo publica al arrancar y al guardar, en
  escritorio y en móvil.
- **No leído.** Si el ajuste no se puede leer al arrancar (o en móvil no se
  abre el almacén en `init`), el estado es «no leído» y las conexiones se
  rechazan. `reload_if_unreadable` lo vuelve a leer antes de cada comando
  del sidecar, de cada `ensure_valid_creds` y de cada comando móvil, así que
  un fallo pasajero se recupera solo.
- **Por cuenta.** `ProxyChoice::Unusable` guarda tal cual un proxy propio que
  no se puede usar (para que los ajustes lo muestren) y lo rechaza; ya no se
  sustituye por el global ni por una conexión directa. Una entrada vacía o
  ausente sigue siendo «heredar el global».
- **Contrato.** `proxy::global()` y `ProxyChoice::resolve()` devuelven
  `Result<Option<ProxyConfig>>`: `None` es directo y el error se propaga en
  cada llamador (IMAP, SMTP, POP3, ManageSieve, Graph, renovación de tokens,
  sonda de certificado, chat, enlaces a la nube y todo `proxy::agent()`).
- **Límites conocidos.** Los libros CardDAV guardados sin cuenta y las listas de tareas CalDAV no
  cuelgan de ninguna cuenta de correo: usan el proxy global (#193). Los
  sockets IMAP ya abiertos y las escuchas IDLE conservan su
  conexión hasta reconectar.

### Qué ve la persona cuando se rechaza el proxy (#201)

- **Forma del error.** Todo rechazo es un `proxy::UnusableProxy`, cuyo
  texto empieza por `UNUSABLE_PREFIX` y dice de quién es el ajuste:
  `proxy setting unusable (app): …` (proxy global, también si no se pudo
  leer) o `proxy setting unusable (account): …` (proxy propio de la
  cuenta). Es un contrato: escritorio y móvil leen el error de
  sincronización como texto.
- **Escritorio** (`ConnectivityBanner`): en lugar de «Unresolved sync
  issue», la cuenta dice que su conexión se rechaza por el ajuste del
  proxy de la app o por el suyo propio, y el botón abre Ajustes → Red
  (sección `network`) o el proxy de esa cuenta (`accountNetwork`). Un
  proxy que no contesta (`connect to proxy host:port`) muestra su
  dirección y abre el proxy propio de la cuenta si lo tiene, si no el
  global. Del error solo se guarda esa clasificación.
- **Móvil** (`MobileConnectivity.kt`): la misma distinción y el mismo
  destino en el aviso de error de sincronización.
- **Microsoft Graph:** el rechazo es `ErrorKind::AppProxyUnusable` o
  `AccountProxyUnusable` (y `auth::Failure` igual al renovar el token),
  no `Transport` ni `Unavailable`, ni una petición de volver a iniciar
  sesión. Su texto es `Microsoft Graph: proxy setting unusable (app)`.
- **Sin reintento:** `is_transient_sync_error` nunca toma un rechazo de
  proxy por un fallo de red pasajero, diga lo que diga su motivo.

## Conexiones

| Conexión | Dónde | Ruta |
|---|---|---|
| IMAP, SMTP, POP3, ManageSieve, Graph, EWS, Google Calendar y contactos, calendarios CalDAV y suscripciones de calendario | núcleo, `ProxyChoice::agent()` o la ruta de la cuenta | proxy de la cuenta o global |
| Libros CardDAV guardados sin cuenta (los que se añaden desde la interfaz) y listas de tareas CalDAV, feeds, idiomas de traducción, changelog | núcleo, `proxy::agent()` | global |
| Búsqueda de ajustes en móvil | núcleo, `protocol/accounts.rs` | global; con proxy se salta la consulta SRV, y un proxy inutilizable es **error** |
| Enlaces a la nube (Nextcloud/ownCloud) | núcleo, `cloud/mod.rs` | global; si el proxy no se puede usar, **error** (antes caía en silencio a directo) |
| Búsqueda de ajustes del servidor (autoconfig, ISPDB) | puente Go, `autodiscover.go` | global |
| Intercambio OAuth y userinfo de Google | puente Go, `oauth.go` | global (la cuenta aún no existe) |
| Imagen de la cuenta | puente Go, `paste_image.go` | proxy de esa cuenta |
| Comprobación y descarga de actualizaciones | puente Go, `update.go` | global |

En el puente Go, `netproxy.go` pide la ruta al núcleo y construye un
`http.Transport` con `Proxy` de `net/http` (`http://` para HTTP CONNECT,
`socks5://` para SOCKS5, que envía el nombre de host al proxy). Sin proxy se
conserva el comportamiento anterior (variables `HTTP(S)_PROXY`). Se mantienen
los plazos de antes (6 s autoconfig, 10 s imagen, 20 s manifiesto; la
descarga sin plazo total pero con límites de TLS y cabeceras).

**Falla cerrado:** si el núcleo no responde, el ajuste no se puede usar o el
proxy no contesta, la petición falla; nunca se reintenta directa. La imagen
de la cuenta, en ese caso, se queda con la URL remota sin descargarla.

Con proxy, la búsqueda de ajustes se salta la consulta DNS SRV (RFC 6186):
DNS no pasa por un proxy HTTP/SOCKS y preguntar al resolvedor local
revelaría el dominio fuera del proxy. Se cae a la suposición
`imap.<dominio>`/`smtp.<dominio>`.

## Lo que no usa el proxy

Las imágenes y medios remotos que carga la vista web (imágenes en mensajes,
fotos de Gravatar/DuckDuckGo) y la página de inicio de sesión que se abre en
el navegador: los carga el motor web o el navegador del sistema, que no
sabe del proxy de la aplicación. Así lo dice `docs/privacy.html`.

## Búsqueda de ajustes solo a petición

Antes la búsqueda se lanzaba al salir del campo de correo y enviaba la
dirección a `autoconfig.<dominio>` y el dominio a la base de Mozilla. Ahora
solo se lanza con el botón «Find settings online» de
`AccountDialogCustom`, con una nota que nombra a quién se pregunta. El
asistente ya no la lanza al pulsar «Continue» ni en la configuración manual.
Además, la dirección va codificada en el parámetro `emailaddress` y se
rechaza un dominio con sintaxis de URL.

## Pruebas

- Go (`netproxy_test.go`): proxy HTTP de prueba que registra peticiones y
  `CONNECT` (con credenciales `Proxy-Authorization`); servidor SOCKS5 de
  prueba que registra el destino y comprueba que llega el nombre sin
  resolver; sin proxy va directo; ajustes inválidos, núcleo ausente y proxy
  que no escucha dan error sin tocar el destino; autodiscover, imagen
  (por cuenta) y actualización pasan por el proxy; escape de la dirección.
- Núcleo: `strict_global` y, para #192, `only_nothing_saved_or_off_reads_as_no_proxy`,
  `an_account_proxy_that_cannot_be_read_is_refused_too`,
  `a_half_filled_account_proxy_is_kept_and_refused_not_replaced`,
  `an_unusable_app_proxy_refuses_every_connection_instead_of_going_direct`,
  `a_proxy_setting_that_cannot_be_read_holds_connections_until_it_can` y
  `an_account_with_an_unusable_proxy_opens_no_socket` (proxy.rs);
  `proxy_route_follows_the_account_and_fails_closed` (store/tests.rs);
  `mobile_autodiscover_refuses_to_look_up_through_an_unusable_proxy`
  (protocol/tests.rs); `an_unusable_proxy_is_an_error_and_never_a_direct_connection`
  (cloud/tests.rs). Para #201:
  `every_refusal_says_proxy_setting_unusable_and_whose_setting_it_is`
  (proxy.rs); `a_proxy_setting_that_cannot_be_used_is_a_proxy_error_and_not_retried`
  (graph/tests.rs), `a_proxy_setting_that_cannot_be_used_is_a_proxy_failure_not_unavailable`
  (graph/auth/tests.rs), `a_proxy_refusal_while_refreshing_the_grant_stays_a_proxy_error`
  (graph/mail/tests.rs); `an_unusable_proxy_setting_is_not_retried_as_a_passing_failure`
  y `graph_failures_do_not_enter_imap_retry_policy` (main.rs).
- Frontend (`AccountDialogCustom.test.tsx`): escribir y salir del campo no
  llama a `account.autodiscover`; el botón sí, y la nota nombra el dominio y
  Mozilla; los servidores se pueden escribir sin búsqueda.
  `ConnectivityBanner.test.tsx` y `connectivityBannerHelpers.test.ts`
  (#201): un proxy global incompleto abre Ajustes → Red, uno propio abre
  el proxy de esa cuenta, y cualquier otro fallo sigue abriendo la cuenta.
- Móvil (`MobileConnectivityTest.kt`, #201): la misma distinción.
