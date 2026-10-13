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

## Conexiones

| Conexión | Dónde | Ruta |
|---|---|---|
| IMAP, SMTP, POP3, EWS, Graph, feeds, CardDAV/CalDAV, idiomas de traducción, changelog | núcleo | proxy de la cuenta o global (ya existía) |
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
- Núcleo: `strict_global` (proxy.rs), `proxy_route_follows_the_account_and_fails_closed`
  (store/tests.rs), `an_unusable_proxy_is_an_error_and_never_a_direct_connection`
  (cloud/tests.rs).
- Frontend (`AccountDialogCustom.test.tsx`): escribir y salir del campo no
  llama a `account.autodiscover`; el botón sí, y la nota nombra el dominio y
  Mozilla; los servidores se pueden escribir sin búsqueda.
