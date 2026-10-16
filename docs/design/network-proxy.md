# Servidor intermediari per a totes les connexions sortints

Quines connexions fan servir el servidor intermediari (proxy) de l'aplicació,
com, i què no el pot fer servir.

## On viu l'opció de configuració

- **Nucli** (`meron-core/src/proxy.rs`): un servidor intermediari global a la
  taula `settings` (clau `proxy`) i, per compte, una elecció `ProxyChoice`:
  heretar el global (per defecte), connexió directa o un servidor intermediari
  propi. Tipus: HTTP CONNECT i SOCKS5; els noms d'amfitrió els resol sempre el
  servidor intermediari, mai el resolutor local.
- **RPC `proxy.route`** (`{account?}`): retorna `{"proxy": null}` (directe)
  o `{"proxy": {mode, host, port, username, password}}`. Amb compte, segueix
  l'elecció d'aquell compte; un compte que encara no existeix (s'està afegint)
  hereta el global. Un servidor intermediari global activat però incomplet (sense
  amfitrió o port) o amb un mode desconegut és un **error**, no «sense servidor
  intermediari».

### Servidor intermediari triat però inutilitzable (#192)

El nucli no converteix mai un servidor intermediari triat en una connexió directa:

- **Global.** L'espai del procés té quatre estats: desactivat, servidor
  intermediari, inutilitzable (amb el motiu) i no llegit (amb el motiu). Només
  «res desat» i `mode` `"off"` o `""` són «desactivat». Un mode amb el servidor o
  el port buits, un port fora de l'interval 1–65535, un mode desconegut o un
  valor que no es pot llegir com a opció de configuració (no és un objecte,
  `mode` no és text) són «inutilitzable». `publish_global` ho publica en
  arrencar i en desar, a l'escriptori i al mòbil.
- **No llegit.** Si l'opció no es pot llegir en arrencar (o, al mòbil, no s'obre
  el magatzem a `init`), l'estat és «no llegit» i les connexions es
  rebutgen. `reload_if_unreadable` la torna a llegir abans de cada ordre
  del sidecar, de cada `ensure_valid_creds` i de cada ordre mòbil, de manera que
  una fallada passatgera es recupera sola.
- **Per compte.** `ProxyChoice::Unusable` desa tal qual un servidor intermediari
  propi que no es pot fer servir (perquè la configuració el mostri) i el
  rebutja; ja no se substitueix pel global ni per una connexió directa. Una
  entrada buida o absent continua sent «heretar el global».
- **Contracte.** `proxy::global()` i `ProxyChoice::resolve()` retornen
  `Result<Option<ProxyConfig>>`: `None` és directe i l'error es propaga a
  cada punt que el crida (IMAP, SMTP, POP3, ManageSieve, Graph, renovació de
  testimonis (tokens), sondeig de certificat, xat, enllaços al núvol i tot `proxy::agent()`).
- **Límits coneguts.** Els llibres CardDAV desats sense compte i les llistes de tasques CalDAV no
  depenen de cap compte de correu: fan servir el servidor intermediari global
  (#193). Els sòcols IMAP ja oberts i les escoltes IDLE conserven la seva
  connexió fins que es tornen a connectar.

### Què veu la persona quan es rebutja el servidor intermediari (#201)

- **Forma de l'error.** És un `proxy::UnusableProxy`, el text del qual comença
  per `UNUSABLE_PREFIX` i diu de qui és l'opció de configuració:
  `proxy setting unusable (app): …` (servidor intermediari global, també si no
  s'ha pogut llegir) o `proxy setting unusable (account): …` (servidor
  intermediari propi del compte). Ho és tot rebuig d'una opció inutilitzable
  (sense servidor o port, tipus desconegut, opció il·legible) i, en les peticions
  HTTP (`ProxyChoice::agent`, `proxy::agent`, `proxied_agent`,
  `scoped_ureq_proxy`: Graph, renovació de testimonis, núvol, fitxers del
  xat…), un servidor que el client HTTP no admet: amb un espai, amb
  el port escrit al camp del servidor o amb lletres fora d'ASCII.
  És un contracte: l'escriptori i el mòbil llegeixen l'error de sincronització
  com a text.
- **Escriptori** (`ConnectivityBanner`): en lloc d'«Unresolved sync
  issue», el compte diu que la seva connexió s'ha rebutjat per l'opció del
  servidor intermediari de l'aplicació o per la seva pròpia, amb «recovery not
  verified», i el botó obre Configuració → Xarxa (secció `network`) o el servidor
  intermediari d'aquell compte (`accountNetwork`). Un servidor intermediari que
  no respon (`connect to proxy host:port`) mostra la seva adreça i obre el
  servidor intermediari propi del compte si en té, i si no, el global. De l'error
  només es desa aquesta classificació. En desar el servidor intermediari global
  (o el del compte) s'esborra la classificació de les fallades que en culpaven
  aquella opció: continuen com a «Unresolved sync issue — recovery not verified».
- **Mòbil** (`MobileConnectivity.kt`): la mateixa distinció i la mateixa
  destinació a l'avís d'error de sincronització; sense un compte conegut,
  obre Configuració → Xarxa. La configuració s'obre a la secció de xarxa, la
  posició de la qual surt de la mateixa llista que construeix la pantalla
  (`SettingsRows`).
- **Microsoft Graph:** el rebuig és `ErrorKind::AppProxyUnusable` o
  `AccountProxyUnusable` (i `auth::Failure` igual en renovar el testimoni),
  no `Transport` ni `Unavailable`, ni una petició de tornar a iniciar
  la sessió. El seu text és `Microsoft Graph: proxy setting unusable (app)`.
  El diàleg d'alta de Graph mostra el missatge del servidor intermediari en lloc
  del codi (`app_proxy_unusable`).
- **Sense reintents:** `is_transient_sync_error` no pren mai un rebuig del
  servidor intermediari per una fallada de xarxa passatgera, digui el que digui
  el seu motiu.
- **Límits coneguts (#201).**
  - Una fallada sense compte (fila «unattributed» de l'escriptori) no mostra
    el missatge del servidor intermediari ni el botó de Xarxa.
  - Només la sincronització del correu ho mostra així. L'enviament, els
    calendaris, els contactes, el xat, l'RSS i les actualitzacions
    mostren els seus propis errors genèrics.
  - En els sòcols de correu (IMAP, SMTP, POP3, ManageSieve), un servidor
    que el client HTTP no admetria no es rebutja per endavant: falla en
    connectar amb el servidor intermediari i es mostra com un servidor
    intermediari que no respon, o com una fallada genèrica si l'adreça no es pot
    llegir. Un servidor escrit com a URL (`http://proxy.corp`) tampoc no es
    rebutja en HTTP: falla en connectar.

## Connexions

| Connexió | On | Ruta |
|---|---|---|
| IMAP, SMTP, POP3, ManageSieve, Graph, EWS, Google Calendar i contactes, calendaris CalDAV i subscripcions de calendari | nucli, `ProxyChoice::agent()` o la ruta del compte | servidor intermediari del compte o global |
| Llibres CardDAV desats sense compte (els que s'afegeixen des de la interfície) i llistes de tasques CalDAV, canals, idiomes de traducció, registre de canvis | nucli, `proxy::agent()` | global |
| Cerca de la configuració al mòbil | nucli, `protocol/accounts.rs` | global; amb servidor intermediari se salta la consulta SRV, i un servidor intermediari inutilitzable és un **error** |
| Assistent amb proveïdor remot | nucli, `assistant::agent` | global |
| Assistent local (un programa en aquest equip) | nucli, `assistant::agent` | sempre directe, sense el servidor intermediari de l'aplicació ni el de l'entorn (#195) |
| Enllaços al núvol (Nextcloud/ownCloud) | nucli, `cloud/mod.rs` | global; si el servidor intermediari no es pot fer servir, **error** (abans passava en silenci a directe) |
| Cerca de la configuració del servidor (autoconfig, ISPDB) | pont Go, `autodiscover.go` | global |
| Intercanvi OAuth i userinfo de Google | pont Go, `oauth.go` | global (el compte encara no existeix) |
| Imatge del compte | pont Go, `paste_image.go` | servidor intermediari d'aquell compte |
| Comprovació i baixada d'actualitzacions | pont Go, `update.go` | global |
| Renovació de testimonis OAuth d'IMAP/SMTP | nucli, `imap::refresh_oauth_token` amb `ProxyChoice::agent()` | servidor intermediari del compte o global; la directa no fa servir `HTTP_PROXY`; amb el global desactivat sí que el respecta (valors per defecte d'`ureq`) |

Canvi de #201: la renovació de testimonis OAuth d'IMAP/SMTP segueix
l'elecció del compte. Abans, un compte «directe» la feia amb els
valors per defecte d'`ureq`, que llegeixen `HTTP_PROXY`; ara va directa de debò.

Al pont Go, `netproxy.go` demana la ruta al nucli i construeix un
`http.Transport` amb `Proxy` de `net/http` (`http://` per a HTTP CONNECT,
`socks5://` per a SOCKS5, que envia el nom d'amfitrió al servidor intermediari).
Sense servidor intermediari es conserva el comportament anterior (variables
`HTTP(S)_PROXY`). Es mantenen els terminis d'abans (6 s autoconfig, 10 s imatge,
20 s manifest; la baixada sense termini total però amb límits de TLS i de
capçaleres).

**Falla tancat:** si el nucli no respon, l'opció no es pot fer servir o el
servidor intermediari no respon, la petició falla; no es torna a provar mai
directament.

Amb servidor intermediari, la cerca de la configuració se salta la consulta DNS
SRV (RFC 6186): el DNS no passa per un servidor intermediari HTTP/SOCKS i
preguntar al resolutor local revelaria el domini fora del servidor intermediari.
Es recorre a la suposició `imap.<dominio>`/`smtp.<dominio>`.

## El que no fa servir el servidor intermediari

L'assistent local (#195): la seva adreça només pot ser aquest equip
(`localhost`, `127.0.0.0/8` o `::1`, comprovat sobre l'amfitrió ja analitzat)
i es crida amb `ProxyChoice::Direct`, de manera que ni el servidor intermediari
de l'aplicació ni `HTTP_PROXY` veuen el correu que la persona ha triat no enviar
fora. Un servidor intermediari global inutilitzable tampoc no el bloqueja.
L'assistent, local o remot, no segueix redireccions: una redirecció duria el
correu i la clau d'aquest equip a un altre amfitrió, o d'HTTPS a HTTP, sense
passar les comprovacions de l'adreça.

Les imatges i els mitjans remots que carrega la visualització web (imatges als
missatges, fotos de Gravatar/DuckDuckGo) i la pàgina d'inici de sessió que s'obre
al navegador: els carrega el motor web o el navegador del sistema, que no
coneix el servidor intermediari de l'aplicació. Així ho diu `docs/privacy.html`.

## Cerca de la configuració només a petició

Abans, la cerca s'iniciava en sortir del camp de l'adreça electrònica i enviava
l'adreça a `autoconfig.<dominio>` i el domini a la base de dades de Mozilla. Ara
només s'inicia amb el botó «Find settings online» d'`AccountDialogCustom`, amb
una nota que anomena a qui es pregunta. L'assistent ja no la inicia en prémer
«Continue» ni a la configuració manual.
A més, l'adreça va codificada al paràmetre `emailaddress` i es
rebutja un domini amb sintaxi d'URL.

## Imatge del compte (#194)

`avatar_url` és sempre una còpia local (`/media/…`) o buida; la interfície
dibuixa les inicials mentre no hi hagi còpia. Si la baixada per la ruta del
compte falla, l'URL d'origen es desa a part a `accounts.avatar_source`
(esquema 63), no es mostra mai, i es torna a provar en arrencar, en restaurar una
còpia de seguretat i en canviar una opció del servidor intermediari (amb 2 s
d'espera i una sola execució en curs, perquè l'opció es desa a cada pulsació).
`account.setAvatar` aplica el resultat d'un reintent només si el compte
continua tal com es va llegir (`expect_avatar_url`, `expect_avatar_source`), de
manera que una baixada lenta no sobreescriu el que la persona ha triat mentrestant.
Un desament des de la configuració que no es pot baixar conserva la imatge
anterior i respon `pending: true`. `account.list` buida qualsevol adreça que no
sigui una còpia local. El mòbil carrega les seves imatges pel seu compte i no es
toca.

## Proves

- Go (`netproxy_test.go`): servidor intermediari HTTP de prova que registra les
  peticions i `CONNECT` (amb credencials `Proxy-Authorization`); servidor SOCKS5
  de prova que registra la destinació i comprova que hi arriba el nom sense
  resoldre; sense servidor intermediari va directe; opcions no vàlides, nucli
  absent i servidor intermediari que no escolta donen error sense tocar la
  destinació; autodiscover, imatge (per compte) i actualització passen pel
  servidor intermediari; escapament de l'adreça.
- Nucli: `strict_global` i, per a #192, `only_nothing_saved_or_off_reads_as_no_proxy`,
  `an_account_proxy_that_cannot_be_read_is_refused_too`,
  `a_half_filled_account_proxy_is_kept_and_refused_not_replaced`,
  `an_unusable_app_proxy_refuses_every_connection_instead_of_going_direct`,
  `a_proxy_setting_that_cannot_be_read_holds_connections_until_it_can` i
  `an_account_with_an_unusable_proxy_opens_no_socket` (proxy.rs);
  `proxy_route_follows_the_account_and_fails_closed` (store/tests.rs);
  `mobile_autodiscover_refuses_to_look_up_through_an_unusable_proxy`
  (protocol/tests.rs); `an_unusable_proxy_is_an_error_and_never_a_direct_connection`
  (cloud/tests.rs). Per a #201:
  `every_refusal_says_proxy_setting_unusable_and_whose_setting_it_is`
  (proxy.rs); `a_proxy_setting_that_cannot_be_used_is_a_proxy_error_and_not_retried`
  (graph/tests.rs), `a_proxy_setting_that_cannot_be_used_is_a_proxy_failure_not_unavailable`
  (graph/auth/tests.rs), `a_proxy_refusal_while_refreshing_the_grant_stays_a_proxy_error`
  (graph/mail/tests.rs); `an_unusable_proxy_setting_is_not_retried_as_a_passing_failure`
  i `graph_failures_do_not_enter_imap_retry_policy` (main.rs);
  `a_server_the_http_client_cannot_use_is_that_setting_being_unusable`
  (proxy.rs), `a_proxy_server_the_http_client_cannot_use_is_a_proxy_error_too`
  (graph/tests.rs), `a_proxy_server_the_http_client_cannot_use_is_a_proxy_failure_too`
  (graph/auth/tests.rs), `a_shared_mailbox_refused_by_its_proxy_names_whose_setting_it_is`
  (engine.rs).
- Nucli, assistent (#195, assistant.rs):
  `a_local_provider_is_reached_directly_even_with_an_app_proxy_set`,
  `a_remote_provider_still_goes_through_the_app_proxy`,
  `an_unusable_app_proxy_refuses_a_remote_provider_but_never_holds_a_local_one`,
  `a_redirect_from_the_provider_is_not_followed`,
  `local_mode_accepts_every_form_of_this_computer_including_ipv6` i
  `local_mode_refuses_hosts_that_are_not_this_computer`.
- Frontend (`AccountDialogCustom.test.tsx`): escriure i sortir del camp no
  crida `account.autodiscover`; el botó sí, i la nota anomena el domini i
  Mozilla; els servidors es poden escriure sense cerca.
  `ConnectivityBanner.test.tsx`, `lib/proxyProblems.test.ts` i
  `AccountDialogGraph.test.tsx`
  (#201): un servidor intermediari global incomplet obre Configuració → Xarxa, un
  de propi obre el servidor intermediari d'aquell compte, i qualsevol altra
  fallada continua obrint el compte.
- Mòbil (`MobileConnectivityTest.kt`, `SettingsRowsTest.kt`, #201): la
  mateixa distinció, i la secció de xarxa on la posen les files de sobre.
- Les proves que publiquen un servidor intermediari global inutilitzable prenen
  `TEST_GLOBAL_LOCK` per escriure. Les que es connecten per la ruta global
  amb un servidor local prenen `steady_global()` per llegir (RSS, núvol,
  fitxers del xat, intercanvi de codi OAuth al mòbil) o fan servir
  `ProxyChoice::Direct` (Google Calendar, EWS, POP3), per no veure aquell
  servidor intermediari a mig configurar. `load_global` també pren la lectura, i
  amb ell `Engine::new`, `ffi::init` i la restauració de còpies: una prova que
  ja té `steady_global()` no pot fer res d'això, de manera que les que
  obren un motor no el prenen.
- `the_oauth_token_refresh_follows_the_account_route` (imap.rs): la
  renovació de testimonis va pel servidor intermediari propi, directa encara que
  n'hi hagi un de global, pel global, i un servidor intermediari propi
  inutilitzable la rebutja sense enviar res.
- Imatge del compte (`avatar_download_test.go`, `oauth_avatar_test.go`,
  `Avatar.test.tsx`, `accounts.test.ts`, i al nucli
  `an_account_picture_and_its_source_are_set_apart`,
  `a_late_avatar_update_does_not_overwrite_a_newer_choice`): una baixada
  fallida no desa ni lliura mai una adreça remota, el reintent fa servir la
  ruta del compte i desa la còpia, i les sol·licituds s'agrupen.
