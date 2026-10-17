# ADR-0070: Llistes de tasques dels comptes activades automàticament (esmena d'ADR-0058 i ADR-0039)

- Estat: proposada. Cal que el propietari l'accepti abans d'escriure'n el codi
  (decisió D8 de la proposta de redisseny, aprovada el 2026-10-17 amb «Lo
  apruebo»: l'esmena necessita la seva pròpia aprovació).
- Data: 2026-10-17.
- Abast: #281 (fila SET-20 del registre d'acceptació, #103) i peça 6 de la
  proposta de redisseny, dins de #288. Esmena el punt 4 d'ADR-0058 (com s'afegeix
  la llista d'un compte d'Exchange) i l'apartat «Enllaç» d'ADR-0039 (CalDAV); la
  resta de totes dues continua igual. Fora d'abast: Google Tasks i To Do de
  Microsoft Graph (encara no existeixen, ADR-0013), altres carpetes de tasques
  d'Exchange i el mòbil.

## Context

- **Calendaris:** els calendaris d'un compte arriben amb el compte i activats
  (`calendars.enabled` val 1 per defecte); desactivar-ne un el conserva.
- **Tasques d'Exchange (ADR-0058, §4):** la llista de la carpeta Tasques només
  s'afegeix a mà, amb el botó «+ Tasques d'Exchange de <compte>» de la
  visualització de Tasques (`TasksView.tsx`). `tasks.exchangeAdd` crea la llista,
  la llegeix sencera i, si la lectura falla, la torna a treure.
- **Tasques CalDAV (ADR-0039):** una llista s'enllaça a mà amb «Llista de
  tasques CalDAV…» (servidor, usuari, col·lecció) i té la seva contrasenya
  (`caldav-tasks:{llista}`). No depèn de cap compte. Els calendaris CalDAV, en
  canvi, sí que són d'un compte, amb la seva sessió (ADR-0018). ADR-0039 va
  descartar llegir `supported-calendar-component-set` per saber quines
  col·leccions accepten tasques.
- **Suprimir una llista** la treu aquí amb les seves tasques, sense tocar el
  servidor, i no en queda cap rastre: el botó per afegir-la torna a aparèixer.
- **El problema (#281):** en la comparació nativa del 2026-10-17, el client de
  referència mostrava les tres tasques del compte d'Exchange; Oreneta deia «cap
  tasca», amb la llista només oferta com a suggeriment.

## Decisió

### 1. Quines llistes són d'un compte

- **Exchange (EWS):** un compte amb `ews_url` té una llista: la seva carpeta
  Tasques, com a ADR-0058.
- **CalDAV:** un compte amb calendaris CalDAV té, a més, una llista per cada
  col·lecció de la mateixa arrel de calendaris (`calendar-home-set`) que declara
  `VTODO` a `supported-calendar-component-set`. Una col·lecció que no declara
  la propietat no s'enllaça sola: no se sap si accepta tasques, i no se suposa.
  Continua disponible amb «Llista de tasques CalDAV…», com ara.
- La lectura de l'atribut `name` de `<C:comp>` s'afegeix al lector WebDAV
  existent (`quick-xml`, ja dependència directa): cap dependència nova.
- Els comptes sense cap d'aquestes dues fonts (IMAP sol, POP3, RSS, Graph,
  Gmail) no canvien.

### 2. Registre de cada llista de compte

- **Taula nova** `account_task_lists`, a la versió d'esquema següent lliure
  quan s'implementi (a `main` i a les PR obertes, el 2026-10-17, l'última és la
  65):

  | Columna | Contingut |
  |---|---|
  | `account` | El compte |
  | `source` | `ews`, o `caldav:<URL de la col·lecció>` |
  | `state` | `pending` (encara no llegida), `linked` (enllaçada) o `declined` (suprimida per la persona) |
  | `list_id` | La llista, quan és `linked` |
  | `last_error` | El motiu de l'última lectura fallida |
  | `updated_at` | Quan va canviar d'estat |

  Clau primària: (`account`, `source`).
- Té columna `account` i se suprimeix amb el compte (ADR-0011); la prova que
  recorre les taules amb compte la classifica com a suprimida. A diferència de
  les llistes CalDAV d'ADR-0039, aquí és el que es vol: el registre és del
  compte.

### 3. En afegir un compte

- Es desa `pending` per a cada font del §1, a la mateixa transacció que el
  compte (CalDAV, quan se'n descobreixen les col·leccions).
- Després, el nucli fa la primera lectura sencera, com fa avui
  `tasks.exchangeAdd` (ADR-0058) o l'enllaç CalDAV (ADR-0039): si va bé, la
  llista queda creada i `linked`; si falla, no es crea cap llista, l'estat
  continua `pending` i es desa el motiu.
- Una llista `pending` es torna a intentar en obrir Tasques i amb
  «Sincronitza», que són els moments en què ja se sincronitzen les tasques
  (ADR-0039). No hi ha cap temporitzador nou.
- **Mai no es diu «cap tasca» d'un compte que no s'ha pogut llegir:** mentre
  hi hagi una llista `pending` amb error, Tasques mostra «Les tasques de
  <compte> no s'han pogut llegir: <motiu>» amb «Torna-ho a provar», i l'agenda
  de la barra lateral diu que pot estar incompleta, com fa amb un calendari que
  no es llegeix (ADR-0059).
- **CalDAV, la sessió:** la llista enllaçada fa servir la sessió del calendari
  del compte (el seu usuari i la seva entrada al clauer), no una còpia de la
  contrasenya. Si el calendari d'aquella sessió se suprimeix, la llista dona un
  error de sessió que ho diu; no en fa servir cap altra.

### 4. En actualitzar un perfil existent

- La migració de l'esquema, una sola vegada:
  - un compte d'Exchange que ja té la seva llista (`task_lists.ews_account`)
    rep `linked` amb aquesta llista;
  - un compte d'Exchange sense llista rep `pending`, i la primera lectura es fa
    en obrir Tasques o amb «Sincronitza»;
  - una llista CalDAV d'ADR-0039 que ja apunta a una col·lecció d'un compte
    (mateixa URL) es registra `linked` en descobrir-la: no es duplica.
- **El que no es pot saber:** fins ara suprimir una llista no deixava cap
  rastre. Una llista que algú va suprimir abans d'aquesta versió no es pot
  distingir d'una que no es va afegir mai, i torna una vegada. Per això, la
  primera vegada que s'obre Tasques després de l'actualització, un avís diu
  quines llistes s'han afegit soles, amb «Treu-la» al costat de cadascuna
  (que la marca `declined`, §5). A partir d'aquesta versió, una supressió
  queda registrada i es respecta sempre.

### 5. Suprimir i tornar a afegir

- «Suprimeix la llista» en una llista de compte fa el que fa avui (la llista i
  les seves tasques se'n van d'aquí, res del servidor) i marca l'entrada
  `declined`. El text de confirmació diu que no tornarà sola i on es torna a
  afegir.
- Una entrada `declined` no es torna a intentar mai, ni en obrir Tasques ni en
  actualitzar.
- Els botons «+ Tasques d'Exchange de <compte>» deixen de ser a la barra de
  llistes; passen a un menú «Afegeix una llista», només per a les entrades
  `declined`, al costat de «Llista de tasques CalDAV…». Afegir-ne una la torna a
  `linked`.
- Suprimir el compte se n'emporta les entrades (§2) i les llistes, com ara.

### 6. Esmenes concretes

- **ADR-0058, §4,** primera línia: la llista no s'obté a mà, arriba amb el
  compte i, en perfils existents, en actualitzar (§3, §4). La regla «es llegeix
  sencera abans d'afegir-la; si falla, no s'afegeix» es manté; ara un error deixa
  l'entrada pendent i visible.
- **ADR-0039, «Enllaç»:** s'hi afegeix el camí automàtic del §1 per a les
  col·leccions d'un compte que declaren `VTODO`, amb la sessió del calendari. La
  llista enllaçada a mà, amb la seva contrasenya, no canvia. L'alternativa
  descartada «Llegir `supported-calendar-component-set`» continua descartada per
  al camí manual, on s'ofereixen totes les col·leccions.
- A totes dues ADR s'afegeix una línia a l'estat que remet a aquesta, com a
  proposada.

## Alternatives descartades

- **Fer servir `enabled`, com els calendaris** (la llista sempre hi és i la
  persona l'amaga): una llista amagada continuaria sincronitzant-se sense que
  ningú la vegi, i #281 parla de llistes suprimides, no amagades.
- **Desar les supressions a les preferències de la interfície:** el compte
  s'afegeix al nucli, el mòbil no veuria la decisió i la supressió del compte no
  se l'emportaria.
- **No activar res en actualitzar** (només els comptes nous): no arregla el
  perfil de la comparació nativa, que és el que va obrir #281.
- **Preguntar per a cada compte en actualitzar:** és el suggeriment d'avui amb
  un altre aspecte.
- **Copiar la contrasenya del calendari CalDAV per a la llista:** dues
  entrades al clauer per a la mateixa sessió, i canviar-ne una deixaria l'altra
  vella.
- **Enllaçar totes les col·leccions CalDAV d'un compte:** cada calendari
  d'esdeveniments es convertiria en una llista de tasques buida.

## Proves

- **Nucli:** compte d'Exchange nou (lectura correcta, `linked`; lectura fallida,
  sense llista, `pending` amb el motiu, i el reintent); migració (amb llista,
  sense llista, una sola vegada); suprimir marca `declined` i no torna, ni en
  sincronitzar ni en tornar a migrar; tornar a afegir; suprimir el compte; la
  prova d'ADR-0011 amb la taula nova; CalDAV amb una col·lecció `VTODO`, una
  sense la propietat i una d'ADR-0039 ja enllaçada (sense duplicat), amb
  respostes enregistrades i contra Radicale.
- **Interfície:** l'avís de llista no llegida i «Torna-ho a provar»; l'avís
  únic després d'actualitzar i «Treu-la»; el menú «Afegeix una llista» només amb
  entrades `declined`; l'agenda incompleta amb una llista pendent.
- **Registre d'acceptació:** nota datada a SET-20; la fila no canvia d'estat
  sense l'evidència nativa (N4) i amb un servidor real (N5).

## Conseqüències

- Una migració d'esquema i una taula nova; cap dependència nova.
- La primera lectura en afegir un compte d'Exchange fa la creació del compte
  més llarga en segon pla; la interfície no l'espera per tancar l'assistent.
- Una llista suprimida abans d'aquesta versió torna una vegada, amb l'avís del
  §4.

## Decisions que ha de prendre el propietari

1. **Actualització:** activar una vegada les llistes dels comptes existents,
   amb l'avís i «Treu-la» (recomanat), o només per als comptes nous.
2. **CalDAV:** incloure'l ara amb la detecció de `VTODO` (recomanat), o només
   Exchange i deixar CalDAV per a més endavant (#281 quedaria obert en part).
3. **Sessió CalDAV:** fer servir la del calendari del compte (recomanat) o una
   còpia de la contrasenya per a la llista, com a ADR-0039.
4. **Suprimir o amagar:** suprimir i recordar-ho (recomanat) o un interruptor
   «activada» com els calendaris.
