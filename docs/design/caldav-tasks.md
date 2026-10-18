# Tasques en un servidor CalDAV (#103, ADR-0039)

## Ús

A **Tasques**:
- «Llista de tasques CalDAV…» demana el servidor, l'usuari i la contrasenya,
  i després cerca les col·leccions. Se'n tria una i el nom que tindrà aquí.
  La llista es llegeix una vegada abans d'afegir-la; si falla, el diàleg
  continua obert amb el motiu.
- En obrir Tasques se sincronitzen totes les llistes enllaçades. Una llista
  enllaçada mostra:
  - on es desa;
  - l'última sincronització;
  - les tasques en conflicte;
  - l'últim error, amb «no s'ha perdut res»;
  - el botó **Sincronitza**.
- Una tasca en conflicte porta la marca «Conflicte», el motiu («canviada aquí
  i al servidor», «suprimida al servidor», «suprimida aquí i canviada al
  servidor») i dos botons: «Conserva la meva» i «Fes servir la del servidor».
- Una tasca que es repeteix es marca com a tal i no s'edita aquí.
- L'editor no permet moure una tasca entre una llista del servidor i una
  altra, i explica per què.
- Suprimir una llista enllaçada avisa que no se suprimeix res al servidor.

## Llistes que arriben amb el compte (#281, ADR-0070)

- **Quines són.** La carpeta Tasques d'un compte d'Exchange i, d'un servidor
  CalDAV que s'afegeix a un compte, les col·leccions que segons
  `supported-calendar-component-set` només admeten `VTODO`, o que admeten
  `VEVENT` i `VTODO` (o no ho diuen) i ja tenen alguna tasca. La propietat ve
  del mateix `PROPFIND` que llista els calendaris; la pregunta «té alguna
  tasca?» és un `calendar-query` que només demana versions. Una resposta que
  no es pot obtenir és «no se sap», mai un «no».
- **Diàleg CalDAV (Calendari › Afegeix un calendari › Servidor CalDAV).**
  Sota els calendaris, «Llistes de tasques d'aquest servidor», ja marcades.
  Una col·lecció de la qual no se sap si té tasques surt desmarcada, amb el
  motiu. Un servidor que només té llistes de tasques també es pot afegir.
- **Primera lectura.** Es llegeix tota la llista i després, en una sola
  transacció, es creen la llista i les tasques. La transacció torna a
  comprovar que el compte encara existeix i que l'entrada encara és
  `pending`; si no, no escriu res. Una lectura fallida no crea res i deixa el
  motiu a l'entrada. La lectura es fa en segon pla en afegir el compte o el
  servidor, i es torna a provar en obrir Tasques i amb «Sincronitza». Quan la
  llista arriba, el nucli emet `tasks.changed`.
- **A Tasques.** Mentre una llista no s'ha llegit, Tasques mostra «S'estan
  llegint les tasques de <compte>…» o «Les tasques de <compte> no s'han pogut
  llegir: <motiu>», amb «Torna-ho a provar» i «No l'afegeixis». Mai no diu
  «Cap tasca» d'un compte que no s'ha llegit, i l'agenda de la barra lateral
  avisa que pot estar incompleta. «Afegeix una llista» (només si n'hi ha una
  de declinada) substitueix els antics botons «Tasques d'Exchange de
  {email}».
- **Suprimir una llista d'un compte** l'esborra d'aquí amb les seves tasques
  i la seva contrasenya, sense tocar el servidor, i la deixa declinada: no
  torna sola. El missatge de confirmació ho diu i només esmenta la
  contrasenya si la llista en té una. Les contrasenyes dels calendaris
  (`caldav:`) no es toquen mai.
- **Actualització.** La migració 66 dona a cada compte d'Exchange la seva
  entrada: `linked`, si ja tenia la llista, o `pending`. També marca cada
  servidor CalDAV amb calendaris (mateix origen i usuari) per tornar-lo a
  llistar una vegada en obrir Tasques, amb la contrasenya d'un d'aquests
  calendaris i només a aquell origen. Les llistes que l'actualització afegeix
  soles porten un avís, a Tasques i a l'agenda, amb «Treu-la» i «D'acord»; la
  resposta es desa al perfil. Una llista que ja existia abans no porta l'avís,
  perquè la va afegir la persona. Una llista manual d'ADR-0039 que apunta a
  la mateixa col·lecció (comparada amb l'adreça normalitzada) s'adopta: no es
  duplica i no se suprimeix amb el compte.

## Nucli

- Codi: `meron-core/src/task_sync/`, amb `vtodo.rs` per a la lectura i
  l'escriptura de VTODO. `calendar::caldav::fetch_todos` comparteix amb
  `fetch_window` la lectura «tot o res».
- RPC:
  - `tasks.caldavDiscover {server, username, password}`;
  - `tasks.caldavAdd {url, name, server, username, password}`;
  - `tasks.sync {list_id?}`: sense `list_id` les sincronitza totes. Respon
    `{lists: [{id, ok, error?, report?}]}` i no falla mai per un servidor;
  - `tasks.resolveConflict {id, keep: "mine"|"server"}`, que sincronitza
    després.
- Ordres ampliades:
  - `tasks.list` retorna `pending`, `conflict` i `recurring`;
  - `tasks.lists` retorna `remote_url`, `remote_user`, `synced_at`,
    `last_error` i `conflicts`;
  - `tasks.deleteList` també suprimeix la contrasenya.
- Esquema 56.
- Clauer: `caldav-tasks:{llista}`, inclòs a
  `profile_purge::secret_names`.
- Pont: les quatre ordres passen sense canvis. `tasks.sync` té 5 minuts i les
  altres tres, 60 segons.
- **Llistes dels comptes (ADR-0070):** `meron-core/src/task_sync/account_lists.rs`.
  - Taula `account_task_lists` (esquema 66), amb clau (`account`, `source`).
    `source` pot ser `ews`, `caldav:<URL normalitzada>` o
    `caldav-server:<origen>|<usuari>` (la marca d'un servidor). Els estats
    són `pending`, `linked`, `declined` i `scanned`. També té `list_id`,
    `adopted`, `notified`, `last_error` i `updated_at`. Se suprimeix amb el
    compte (ADR-0011).
  - `caldav.discover` torna, per a cada col·lecció, `components`, `events`,
    `tasks` (`null`, amb `tasks_error`, quan no se sap) i té 3 minuts al pont.
  - `caldav.add {…, task_lists?, declined_task_lists?, server?}` accepta un
    servidor sense calendaris i rebutja només una petició sense calendaris
    ni llistes. Cada llista té la seva contrasenya
    (`caldav-tasks-pending:{compte}:{resum (hash) del source}` mentre és
    pendent, i `caldav-tasks:{llista}` quan s'enllaça). La clau nova
    s'escriu abans i la pendent s'esborra quan la transacció s'ha confirmat.
  - `tasks.lists` torna també `account_lists`: totes les entrades, excepte
    els servidors ja llistats. `tasks.sync` sense `list_id` llegeix també el
    que és pendent i respon `accounts`.
  - Ordres noves: `tasks.declineAccountList {account, source}` («No
    l'afegeixis», «Treu-la») i `tasks.acknowledgeAccountList {account,
    source}` («D'acord»). Esdeveniment nou: `tasks.changed {account,
    list_id?}`.
  - `tasks.exchangeAdd {account}` llegeix primer i crea després.
    `tasks.caldavAdd` amb `account` torna a afegir una llista declinada del
    compte; si no rep contrasenya, fa servir la d'un calendari del compte
    amb el mateix origen i el mateix usuari. Si no n'hi ha cap, el menú la
    demana.
  - Cada petició d'una lectura d'un compte passa per `OriginBound`, que no
    envia res fora de l'origen de la col·lecció (#28). Va per la ruta del
    compte (#193).
  - `profile_purge::secret_names` inclou les claus `caldav-tasks-pending:`
    (ADR-0038).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 Rust VTODO (`task_sync/vtodo/tests.rs`) | Lectura d'un altre client (zona, prioritat, alarma relativa a `DUE`); una edició només canvia el que s'ha canviat i conserva X-, `CATEGORIES`, `RELATED-TO`, `VTIMEZONE`, `PERCENT-COMPLETE`, alarmes; `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED`; prioritat en els dos sentits (el 5 es conserva si continua sent normal); data sola com a mitjanit local i escrita com a data; completar i reobrir; alarmes substituïdes només si canvia el recordatori; tasca nova completa amb seqüències d'escapada; tasca que es repeteix llegida i no editada; objecte sense tasca rebutjat; plegament de línies llargues. Passen amb el `TZ` de Nova York, Calcuta i Chatham |
| N1 Rust sincronització (`task_sync/tests.rs`, servidor fals) | La primera lectura importa; edició local amb `If-Match` que conserva el que és d'altri; completar i suprimir (làpida (tombstone) oculta, després `DELETE` amb `If-Match`); tasca nova amb `If-None-Match` i UID `@oreneta`, sense duplicar en tornar a llegir; canvi remot incorporat i revisió pujada; canvi als dos costats en conflicte sense sobreescriure'n cap; un 412 atura la cua d'aquella llista i no la d'una altra, i continua aturada mentre duri el conflicte; una supressió remota treu la tasca sense canvis i deixa en conflicte la canviada; un objecte que no torna o que no es llegeix no canvia res i deixa l'error; la contrasenya no surt mai del servidor (resposta amb un altre origen, adreça local manipulada, enllaç a HTTP des d'HTTPS, col·lecció ja enllaçada); resoldre amb la del servidor i amb la meva (sobre la versió actual i creant-la de nou si s'havia suprimit); suprimir la llista no envia res; moure i editar una tasca que es repeteix es rebutja; un recordatori passat en importar no sona |
| N1 distribuïdor (`main.rs`) | Servidor inabastable: `tasks.caldavAdd` no afegeix res; `tasks.sync` respon l'error, la llista el desa i la tasca continua pendent; `tasks.resolveConflict` sense conflicte falla; suprimir la llista |
| N1 proteccions | `profile_purge` anomena el secret nou i compta 12 escriptures; esquema 56 a les proves de migració |
| N2 (`CalDavTaskLists.test.tsx`) | Afegir una llista: cercar, triar la col·lecció, el nom i l'alta; un error en afegir deixa el diàleg obert amb el motiu; sincronitza en obrir només si hi ha llistes enllaçades; error de sincronització visible i botó Sincronitza; «Conserva la meva» i «Fes servir la del servidor»; moure entre llistes rebutjat sense desar |
| N3 Radicale (`integration_caldav_tasks_test.go`) | Descobrir i afegir, edició que conserva el que és d'altri, conflicte sense res escrit i «Conserva la meva», tasca nova creada i suprimir la llista sense tocar el servidor. Provat amb Radicale 3.5.4 local; a la CI s'executa amb la imatge Docker de l'arnès |
| N1 Rust llistes dels comptes (`task_sync/account_lists/tests.rs`, servidor fals) | Adreça normalitzada (una col·lecció escrita de dues maneres és una sola entrada); quines col·leccions són llistes del compte (només `VTODO`, mixta amb tasques i sense, sense la propietat, només `VEVENT`) i només es pregunta a les que poden tenir tasques; una pregunta sense resposta és «no se sap»; la primera lectura sencera abans de crear res; una lectura fallida no crea res i deixa el motiu; una lectura que acaba després de «No l'afegeixis» o de suprimir el compte no escriu res; cada transició del §5; suprimir una llista no toca el servidor ni el calendari; suprimir el compte s'emporta les llistes soles i conserva les adoptades, amb les claus que cal esborrar; un servidor afegit ara no es torna a llistar; la relectura de l'actualització (una sola vegada, amb un calendari del mateix origen i usuari, cap col·lecció d'un altre origen, adopció sense duplicat, avís fins a «D'acord»); la migració d'Exchange (amb llista, sense llista, una sola vegada, una llista declinada continua declinada); l'usuari de l'inici de sessió; `OriginBound` |
| N1 Rust Exchange (`task_sync/exchange/tests.rs`) | El compte nou arriba amb les seves tasques llegides senceres i sense avís; una lectura fallida no crea res i espera amb el motiu; una lectura que acaba després de «No l'afegeixis» o de suprimir el compte no escriu res; una llista declinada no es torna a llegir i es torna a afegir a mà |
| N1 proteccions (ADR-0070) | `profile_purge` anomena les claus pendents; la taula nova és a la prova d'ADR-0011; esquema 66 a les proves de migració |
| N2 (`AccountTaskLists.test.tsx`, `ExchangeTaskLists.test.tsx`, `CalDavCalendars.test.tsx`, `SidebarAgenda.test.tsx`) | «S'estan llegint…» en lloc de «Cap tasca» i lectura en obrir Tasques; l'error, «Torna-ho a provar» i «No l'afegeixis»; l'avís de l'actualització amb «Treu-la» i «D'acord», a Tasques i a l'agenda; «Afegeix una llista» només amb entrades declinades; el text de suprimir una llista del compte; Tasques oberta mostra la llista quan arriba `tasks.changed`; el diàleg CalDAV amb les llistes marcades, la desconeguda desmarcada i un servidor només de tasques; l'agenda incompleta amb una entrada pendent |
| N3 Radicale (`integration_account_task_lists_test.go`) | `caldav.discover` amb els components reals; `caldav.add` llegeix la llista triada en segon pla i emet `tasks.changed`; la desmarcada queda declinada; una llista suprimida no torna amb «Sincronitza»; es torna a afegir amb la contrasenya del calendari del mateix servidor |
| N5 pendent | Nextcloud, Fastmail i iCloud abans d'anunciar-los |
