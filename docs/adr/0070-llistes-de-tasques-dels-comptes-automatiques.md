# ADR-0070: Llistes de tasques dels comptes activades automàticament (esmena d'ADR-0058 i ADR-0039)

- Estat: proposada. Cal que el propietari l'accepti abans d'escriure'n el codi.
  La decisió D8 de la proposta de redisseny demanava escriure aquesta esmena; el
  propietari va aprovar la proposta el 2026-10-17 («Lo apruebo»), abans que
  existís aquest text, i l'esmena necessita la seva pròpia acceptació. Les
  decisions D1–D9 consten a
  [#288](https://github.com/adilelhaji/oreneta/issues/288#issuecomment-6240630278).
- Data: 2026-10-17.
- Abast: #281 (fila SET-20 del registre d'acceptació, #103) i peça 6 de la
  proposta de redisseny, dins de #288. Esmena el primer punt del §4 d'ADR-0058
  («Una llista per compte d'Exchange…») i, d'ADR-0039, els apartats «Enllaç»,
  «Suprimir una llista enllaçada», la nota de l'«Esquema 56» sobre la supressió
  per compte i l'aplicació de «Seguretat (#28)», i amplia la purga d'ADR-0038
  (vegeu el §7). Fora d'abast:
  Google Tasks i To Do de Microsoft Graph (encara no existeixen, ADR-0013),
  altres carpetes de tasques d'Exchange i el mòbil.

## Context

- **Calendaris:** els calendaris d'un compte d'Exchange o de Google arriben amb
  el compte i activats (`calendars.enabled` val 1 per defecte); desactivar-ne
  un el conserva. Els calendaris CalDAV (ADR-0018) s'afegeixen a un compte des
  d'un diàleg: `caldav.discover` llista les col·leccions del servidor (sense
  desar res) i `caldav.add` desa les triades, cadascuna amb una còpia de la
  contrasenya al clauer (`caldav:{compte}:{calendari}`).
- **Tasques d'Exchange (ADR-0058, §4):** la llista de la carpeta Tasques només
  s'afegeix a mà, amb el botó «Tasques d'Exchange de {email}» de Tasques
  (`TasksView.tsx`). `tasks.exchangeAdd` crea la llista, la llegeix sencera i,
  si la lectura falla, la torna a esborrar.
- **Tasques CalDAV (ADR-0039):** una llista s'enllaça a mà amb «Llista de
  tasques CalDAV…» (servidor, usuari, col·lecció) i té la seva contrasenya
  (`caldav-tasks:{llista}`). No depèn de cap compte i no se suprimeix amb cap
  compte. ADR-0039 va descartar llegir `supported-calendar-component-set`.
- **Suprimir una llista** l'esborra d'Oreneta amb les seves tasques (i, si és
  CalDAV, la seva contrasenya), sense tocar el servidor, i no en queda cap
  rastre: el botó per afegir-la torna a aparèixer.
- **El problema (#281):** en la comparació nativa del 2026-10-17, el client de
  referència mostrava les tres tasques del compte d'Exchange; Oreneta deia «cap
  tasca», amb la llista només oferta com a suggeriment.

## Decisió

### 1. Quines llistes són d'un compte

- **Exchange (EWS):** un compte amb `ews_url` té una llista: la seva carpeta
  Tasques, com diu ADR-0058.
- **CalDAV:** les col·leccions d'un servidor CalDAV que s'afegeix a un compte,
  segons el que declaren a `supported-calendar-component-set` (RFC 4791,
  §5.2.3; si la propietat falta, el servidor accepta tots els components):
  - només `VTODO`: és una llista del compte;
  - `VEVENT` i `VTODO`, o sense la propietat (Nextcloud i Radicale creen així
    els calendaris): és una llista del compte només si una consulta `VTODO`
    (`calendar-query`) hi troba almenys una tasca; si no, no ho és (així no es
    converteix cada calendari d'esdeveniments en una llista buida) i es pot
    continuar enllaçant a mà amb «Llista de tasques CalDAV…»;
  - només `VEVENT`: no.
- La propietat es demana en el mateix `PROPFIND` (profunditat 1) que ja llista
  les col·leccions, de manera que no cal una consulta per col·lecció per saber
  els components (l'objecció d'ADR-0039). El lector WebDAV, que ja fa servir
  `quick-xml` (dependència directa), aprèn a llegir l'atribut `name` de
  `<C:comp>`: cap dependència nova.
- Els comptes sense cap d'aquestes dues fonts (IMAP sol, POP3, RSS, Graph,
  Gmail) no canvien.

### 2. Registre de cada llista de compte

- **Taula nova** `account_task_lists`, a la primera versió d'esquema lliure
  quan s'implementi (a `main` i a les branques obertes, el 2026-10-17, l'última
  és la 65):

  | Columna | Contingut |
  |---|---|
  | `account` | El compte |
  | `source` | `ews`; `caldav:<URL normalitzada de la col·lecció>`; o `caldav-server:<origen>|<usuari>`, la marca d'un servidor ja llistat (§4) |
  | `state` | `pending` (encara no llegida), `linked` (enllaçada), `declined` (la persona no la vol) o, només per a les marques de servidor, `scanned` (ja llistat) |
  | `list_id` | La llista, quan és `linked` |
  | `adopted` | 1 si és una llista manual d'ADR-0039 que ja existia (§4) |
  | `notified` | 1 quan la persona ha confirmat l'avís de l'actualització (§4). Només hi neixen amb 0 les entrades creades per la migració o per la relectura del §4 que no són adoptades; totes les altres neixen amb 1 |
  | `last_error` | El motiu de l'última lectura fallida |
  | `updated_at` | Quan va canviar d'estat |

  Clau primària: (`account`, `source`).
- **URL normalitzada:** esquema i host en minúscules, sense el port per
  defecte, codificació per cent normalitzada (els caràcters no reservats,
  descodificats; la resta, en majúscules) i una barra final. Dues formes de la
  mateixa col·lecció són la mateixa entrada.
- Té la columna `account` i se suprimeix amb el compte (ADR-0011): la prova que
  recorre les taules amb compte la classifica com a suprimida.

### 3. En afegir un compte o un servidor CalDAV

- **Exchange:** es desa `pending` a la mateixa transacció que el compte.
- **CalDAV:** `caldav.discover` torna també els components de cada col·lecció,
  i el diàleg mostra, sota els calendaris, les llistes de tasques del §1 ja
  marcades. `caldav.add` rep les col·leccions de tasques triades i desa
  `pending` per a cadascuna, les col·leccions de tasques que la persona
  desmarca com a `declined` i la marca del servidor com a `scanned` (§4), de
  manera que aquest servidor no es torna a llistar sol. Cada llista té la seva
  còpia de la contrasenya (`caldav-tasks:{llista}`), com les d'ADR-0039 i com
  cada calendari CalDAV ja té la seva. Mentre l'entrada és `pending` i encara no
  hi ha llista, la còpia es desa amb una clau pròpia
  (`caldav-tasks-pending:{compte}:{resum (hash) del source}`), que és la que
  fan servir els nous intents; en enllaçar-la passa a `caldav-tasks:{llista}`
  (primer s'escriu la nova i, quan la transacció s'ha confirmat, s'esborra la
  pendent). La clau pendent s'esborra quan l'entrada passa a `declined` i quan
  se suprimeix el compte, i s'afegeix al que purga ADR-0038. La contrasenya
  només va a l'origen de la col·lecció, comprovat en enllaçar i a cada petició
  (#28).
- **La primera lectura** la fa el nucli, sencera, com avui
  `tasks.exchangeAdd` o l'enllaç d'ADR-0039. Primer es llegeix; després, en una
  sola transacció, es creen la llista i les seves tasques i l'entrada passa a
  `linked`. Si la lectura falla, no es crea res, l'entrada continua `pending` i
  es desa el motiu. Així no hi pot quedar una llista a mitges si l'aplicació es
  tanca durant la lectura.
- És una lectura: no s'envia res al servidor, i es fa una sola vegada, com a
  resposta a una acció de la persona (afegir el compte). Els reintents d'una entrada `pending` es fan en
  obrir Tasques i amb «Sincronitza», que són els moments en què ja se
  sincronitzen les tasques (ADR-0039). No hi ha cap temporitzador nou.
- Quan una llista passa a `linked`, el nucli emet `tasks.changed`, i Tasques i
  l'agenda de la barra lateral (ADR-0069) la tornen a llegir encara que ja
  estiguin obertes.
- **Mai no es diu «cap tasca» d'un compte que no s'ha llegit:** `tasks.lists`
  torna també les entrades `pending` i `declined` dels comptes. Mentre n'hi
  hagi una de `pending`, amb error o sense, Tasques mostra «S'estan llegint les
  tasques de <compte>…» o «Les tasques de <compte> no s'han pogut llegir:
  <motiu>», amb «Torna-ho a provar» i «No l'afegeixis», i l'agenda diu que pot
  estar incompleta, com fa amb un calendari que no es llegeix (ADR-0059).

### 4. En actualitzar un perfil existent

- **Exchange,** a la migració de l'esquema, una sola vegada:
  - un compte que ja té la seva llista (`task_lists.ews_account`) rep `linked`
    amb aquesta llista;
  - un compte sense llista rep `pending`, i la primera lectura es fa en obrir
    Tasques o amb «Sincronitza».
- **CalDAV:** la migració no pot anar a la xarxa. La primera vegada que s'obre
  Tasques després de l'actualització, per cada servidor CalDAV que ja té
  calendaris en un compte (mateix origen i usuari), es tornen a llistar les
  col·leccions amb la contrasenya d'un d'aquests calendaris, només a aquell
  origen, i s'hi aplica el §1. Una col·lecció d'un altre origen no s'enllaça
  sola. Es fa una vegada per servidor, i es recorda amb la marca
  `caldav-server:<origen>|<usuari>` del §2: `scanned` quan la relectura ha anat
  bé; si falla, `pending` amb el motiu, que Tasques mostra («No s'ha pogut
  tornar a llistar el servidor <origen>: <motiu>», amb «Torna-ho a provar» i
  «No l'afegeixis», que la passa a `declined`) i que es torna a provar com les
  altres entrades. Una marca no té llista (`list_id` buit). Un servidor afegit
  després de l'actualització ja té la seva marca (§3) i no es torna a llistar.
  Les col·leccions que apareguin després al servidor no s'afegeixen soles. Les
  entrades que crea aquesta relectura desen la contrasenya amb la clau pendent
  del §3.
- **Llistes manuals d'ADR-0039** que ja apunten a una col·lecció trobada (la
  mateixa URL normalitzada): es registren `linked` amb `adopted = 1`. No es
  dupliquen, conserven la seva contrasenya i no se suprimeixen amb el compte.
- **El que no es pot saber:** fins ara suprimir una llista no deixava cap
  rastre. Una llista que algú va suprimir abans d'aquesta versió no es pot
  distingir d'una que no es va afegir mai, i torna una vegada. Per això, les
  llistes afegides soles en actualitzar porten un avís, a Tasques i a dalt de
  l'agenda de la barra lateral, amb «Treu-la» (que la marca `declined`, §5) i
  «D'acord». L'avís es manté fins que es fa una de les dues coses, i la
  confirmació es desa a `notified`, al perfil, i no a la interfície. Un compte
  nou no mostra mai aquest avís. A partir d'aquesta versió, una
  supressió queda registrada i es respecta sempre. El criteri de #281 («una
  llista suprimida continua suprimida») només es pot complir per a les
  supressions fetes des d'aquesta versió: és una limitació que el propietari ha
  d'acceptar (decisió 1).

### 5. Estats i transicions

| Des de | Què passa | A |
|---|---|---|
| — | Afegir el compte, el servidor o actualitzar | `pending` (una col·lecció desmarcada al diàleg: `declined`) |
| `pending` | Lectura correcta | `linked` |
| `pending` | Lectura fallida | `pending`, amb el motiu |
| `pending` | «No l'afegeixis» | `declined` |
| `linked` | «Suprimeix la llista» | `declined` |
| `declined` | «Afegeix una llista» → la llista, lectura correcta | `linked` |
| `declined` | «Afegeix una llista» → la llista, lectura fallida | `declined`; el diàleg diu el motiu, com avui |
| marca `pending` | Relectura correcta | marca `scanned`, i una entrada per col·lecció trobada |
| marca `pending` | «No l'afegeixis» | marca `declined` |
| qualsevol | Suprimir el compte | l'entrada desapareix |

- **Suprimir una llista de compte:** se'n van d'Oreneta la llista i les seves
  tasques, sense tocar res del servidor, i l'entrada passa a `declined`. La
  seva contrasenya pròpia (`caldav-tasks:{llista}`) se suprimeix, com avui; la
  dels calendaris (`caldav:`) no es toca mai, i els calendaris continuen
  sincronitzant-se. El text de confirmació diu que la llista no tornarà sola i
  on es torna a afegir, i només parla de contrasenya si la llista en té una.
- Una entrada `declined` no es torna a llegir mai, ni en obrir Tasques ni en
  actualitzar.
- Els botons «Tasques d'Exchange de {email}» deixen la barra de llistes; passen
  a un menú «Afegeix una llista», només per a les entrades `declined`, al costat
  de «Llista de tasques CalDAV…». Tornar a afegir una llista CalDAV fa servir
  la contrasenya d'un calendari del compte amb el mateix origen i el mateix
  usuari, amb la regla de #28; si no n'hi ha cap, el diàleg la demana.
- **Una col·lecció que desapareix del servidor** (404 en llegir-la): la llista
  `linked` mostra l'error de sincronització d'ADR-0039 i no se suprimeix sola;
  la persona la pot suprimir.
- **Suprimir el compte** s'emporta les entrades, les claus pendents del §3, les llistes d'Exchange (com
  avui) i les llistes CalDAV enllaçades soles, amb les seves contrasenyes. Les
  llistes adoptades (`adopted = 1`) es queden, com diu ADR-0039.

### 6. Contractes que canvien

- `caldav.discover`: torna els components de cada col·lecció.
- `caldav.add`: rep també les col·leccions de tasques.
- `tasks.lists`: torna també les entrades `pending` i `declined` dels comptes,
  amb el motiu i l'estat de l'avís.
- Noves: `tasks.declineAccountList` («No l'afegeixis», «Treu-la»),
  `tasks.acknowledgeAccountList` («D'acord») i l'esdeveniment `tasks.changed`.
- `tasks.exchangeAdd` passa a llegir primer i crear després (§3).

### 7. Esmenes concretes

- **ADR-0058, §4, primer punt:** la llista no s'afegeix a mà; arriba amb el
  compte i, en perfils existents, en actualitzar (§3 i §4). La regla «es llegeix
  sencera abans d'afegir-la; si falla, no s'afegeix» es manté; ara un error deixa
  l'entrada pendent i visible.
- **ADR-0039:**
  - «Enllaç»: s'hi afegeix el camí del §1 i del §3 per a les col·leccions de
    tasques d'un servidor que s'afegeix a un compte. La llista enllaçada a mà
    no canvia. L'alternativa descartada «Llegir `supported-calendar-component-set`»
    deixa de ser-ho per a aquest camí; al camí manual es continuen oferint totes les
    col·leccions;
  - «Suprimir una llista enllaçada»: en una llista de compte, a més, l'entrada
    passa a `declined` (§5);
  - «Esquema 56»: les llistes CalDAV enllaçades soles se suprimeixen amb el
    compte a través de `account_task_lists`; les manuals i les adoptades, no;
  - «Seguretat (#28)»: s'aplica igual a la relectura del §4 i a tornar a
    afegir una llista (§5), que només fan servir una contrasenya a l'origen del
    calendari d'on surt.
- **ADR-0038:** el que es purga en suprimir un perfil amb dades inclou també
  les claus `caldav-tasks-pending:`.
- A totes dues ADR s'afegeix a l'estat una línia que remet a aquesta
  (proposada).

## Alternatives descartades

- **Fer servir `enabled`, com els calendaris** (la llista sempre hi és i la
  persona l'amaga): una llista amagada continuaria sincronitzant-se sense que
  ningú la veiés, i #281 parla de llistes suprimides, no amagades.
- **Desar les supressions a les preferències de la interfície:** el compte
  s'afegeix al nucli, el mòbil no veuria la decisió i la supressió del compte no
  se l'emportaria.
- **No activar res en actualitzar** (només els comptes nous): no arregla el
  perfil de la comparació nativa, que és el que va obrir #281.
- **Preguntar per a cada compte en actualitzar:** és el suggeriment d'avui amb
  un altre aspecte.
- **Fer servir la contrasenya del calendari en lloc d'una còpia:** la llista
  dependria d'un calendari concret (quin, si n'hi ha diversos?) i deixaria de
  funcionar si aquest calendari se suprimeix; cada calendari CalDAV ja en té la
  seva còpia, i ADR-0038 ja purga les de `caldav-tasks:`.
- **Enllaçar totes les col·leccions CalDAV que admeten tasques:** a Nextcloud i
  Radicale, cada calendari d'esdeveniments seria una llista de tasques buida.
- **Crear la llista abans de llegir i esborrar-la si falla** (com avui
  `tasks.exchangeAdd`): un tancament a mitja lectura deixa una llista a mitges.

## Proves

- **Nucli:** compte d'Exchange nou (lectura correcta, `linked`; lectura
  fallida, sense llista, `pending` amb el motiu, i el nou intent; tancament a
  mitja lectura sense llista a mitges); migració (amb llista, sense llista, una
  sola vegada); cada transició de la taula del §5; una llista suprimida no torna, ni en
  sincronitzar ni en tornar a migrar; suprimir una llista CalDAV de compte no
  toca `caldav:` i el calendari se sincronitza; suprimir el compte s'emporta les
  llistes soles i conserva les adoptades; la clau pendent d'una entrada CalDAV
  (nou intent amb ella, pas a `caldav-tasks:` en enllaçar, esborrada en passar
  a `declined` i amb el compte); la marca `scanned` (un servidor afegit després
  no es torna a llistar; les col·leccions desmarcades queden `declined`); un
  compte nou no mostra l'avís de l'actualització; tornar a afegir una llista
  CalDAV amb la contrasenya d'un calendari del mateix origen, i sense cap; la
  prova d'ADR-0011 amb la taula nova;
  CalDAV amb una col·lecció només `VTODO`, una mixta amb tasques i una sense,
  una sense la propietat, una d'un altre origen, una d'ADR-0039 ja enllaçada
  (adoptada, sense duplicat) i la mateixa URL escrita de formes diferents, amb
  respostes enregistrades i amb un servidor Radicale; `tasks.changed`.
- **Interfície:** «S'estan llegint…», l'error, «Torna-ho a provar» i «No
  l'afegeixis»; l'avís de l'actualització a Tasques i a l'agenda, amb «Treu-la»
  i «D'acord»; el menú «Afegeix una llista» només amb entrades `declined`;
  l'agenda incompleta amb una entrada pendent; el diàleg CalDAV amb les llistes
  marcades; Tasques oberta que mostra la llista quan arriba `tasks.changed`.
- **Registre d'acceptació:** nota datada a SET-20, que continua `partial`
  (Google Tasks i To Do de Graph no hi són) i no canvia d'estat sense
  l'evidència nativa (N4).

## Conseqüències

- Una migració d'esquema i una taula nova; cap dependència nova. Com qualsevol
  versió d'esquema nova, una versió anterior de l'aplicació ja no obrirà el
  perfil actualitzat (`SCHEMA_VERSION`, `store/db.rs`).
- La primera lectura en afegir un compte d'Exchange allarga en segon pla la
  creació del compte; la interfície no l'espera per tancar l'assistent.
- Una llista suprimida abans d'aquesta versió torna una vegada, amb l'avís del
  §4.
- **Documents que s'actualitzen amb la peça:** caldav-tasks.md i
  task-lists.md.

## Decisions que ha de prendre el propietari

1. **Actualització:** activar una vegada les llistes dels comptes existents,
   amb l'avís i «Treu-la», i acceptar que una llista suprimida abans d'aquesta
   versió torni una vegada (recomanat), o activar-les només per als comptes
   nous.
2. **CalDAV:** incloure'l ara amb la regla del §1 (recomanat), o només Exchange
   i deixar CalDAV per a més endavant (#281 quedaria obert en part).
3. **Contrasenya de les llistes CalDAV automàtiques:** una còpia pròpia, com
   ADR-0039 i com cada calendari (recomanat), o la del calendari.
4. **Suprimir o amagar:** suprimir i recordar-ho (recomanat) o un interruptor
   «activada» com els calendaris.
5. **Llistes manuals d'ADR-0039 que coincideixen amb una col·lecció del compte:**
   adoptar-les sense lligar-les a la vida del compte (recomanat) o deixar-les
   fora del registre.
