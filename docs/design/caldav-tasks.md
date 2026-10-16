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

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 Rust VTODO (`task_sync/vtodo/tests.rs`) | Lectura d'un altre client (zona, prioritat, alarma relativa a `DUE`); una edició només canvia el que s'ha canviat i conserva X-, `CATEGORIES`, `RELATED-TO`, `VTIMEZONE`, `PERCENT-COMPLETE`, alarmes; `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED`; prioritat en els dos sentits (el 5 es conserva si continua sent normal); data sola com a mitjanit local i escrita com a data; completar i reobrir; alarmes substituïdes només si canvia el recordatori; tasca nova completa amb seqüències d'escapament; tasca que es repeteix llegida i no editada; objecte sense tasca rebutjat; plegament de línies llargues. Passen amb el `TZ` de Nova York, Calcuta i Chatham |
| N1 Rust sincronització (`task_sync/tests.rs`, servidor fals) | La primera lectura importa; edició local amb `If-Match` que conserva el que és d'altri; completar i suprimir (làpida (tombstone) oculta, després `DELETE` amb `If-Match`); tasca nova amb `If-None-Match` i UID `@oreneta`, sense duplicar en tornar a llegir; canvi remot incorporat i revisió pujada; canvi als dos costats en conflicte sense sobreescriure'n cap; un 412 atura la cua d'aquella llista i no la d'una altra, i continua aturada mentre duri el conflicte; una supressió remota treu la tasca sense canvis i deixa en conflicte la canviada; un objecte que no torna o que no es llegeix no canvia res i deixa l'error; la contrasenya no surt mai del servidor (resposta amb un altre origen, adreça local manipulada, enllaç a HTTP des d'HTTPS, col·lecció ja enllaçada); resoldre amb la del servidor i amb la meva (sobre la versió actual i creant-la de nou si s'havia suprimit); suprimir la llista no envia res; moure i editar una tasca que es repeteix es rebutja; un recordatori passat en importar no sona |
| N1 distribuïdor (`main.rs`) | Servidor inabastable: `tasks.caldavAdd` no afegeix res; `tasks.sync` respon l'error, la llista el desa i la tasca continua pendent; `tasks.resolveConflict` sense conflicte falla; suprimir la llista |
| N1 proteccions | `profile_purge` anomena el secret nou i compta 12 escriptures; esquema 56 a les proves de migració |
| N2 (`CalDavTaskLists.test.tsx`) | Afegir una llista: cercar, triar la col·lecció, el nom i l'alta; un error en afegir deixa el diàleg obert amb el motiu; sincronitza en obrir només si hi ha llistes enllaçades; error de sincronització visible i botó Sincronitza; «Conserva la meva» i «Fes servir la del servidor»; moure entre llistes rebutjat sense desar |
| N3 Radicale (`integration_caldav_tasks_test.go`) | Descobrir i afegir, edició que conserva el que és d'altri, conflicte amb res escrit i «Conserva la meva», tasca nova creada i suprimir la llista sense tocar el servidor. Provat contra Radicale 3.5.4 local; a la CI s'executa amb la imatge Docker de l'arnès |
| N5 pendent | Nextcloud, Fastmail i iCloud abans d'anunciar-los |
