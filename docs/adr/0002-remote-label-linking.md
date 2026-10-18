# ADR-0002: Vinculació d'etiquetes remotes: etiqueta local, vincle opcional per compte, en tots dos sentits

- **Estat:** Acceptada
- **Data:** 2026-09-07
- **Decisors:** Adil El Haji (mantenidor)
- **Relacionat:** [ADR-0001](0001-web-engine-and-extensions.md)

## Context

Les etiquetes d'Oreneta són, avui, locals i per conversa per disseny. El
mateix comentari del magatzem d'etiquetes ho diu directament
([`frontend/src/states/labels.ts`](../../frontend/src/states/labels.ts)):

> Local to this install, and the interface says so where it matters: an IMAP
> keyword is not carried by every server and an Exchange category is a
> different thing again, so a label that appeared on one device and silently
> not on another would be worse than one that never claimed to travel.

El mantenidor va demanar afegir-hi sincronització remota: una etiqueta
creada a Oreneta hauria de ser visible a Gmail, a Outlook o en un altre
client IMAP, i a l'inrevés, tot mantenint la interfície de la barra de
filtres ràpids, que aquest ADR no dissenya (incidència separada). Tres
servidors, tres formes diferents del que és una «etiqueta»:

| Servidor | Què existeix | Color | Abast |
|---|---|---|---|
| Gmail (IMAP) | `X-GM-LABELS`, condicionat a la capacitat `X-GM-EXT-1`, que Oreneta ja detecta per a `X-GM-THRID`/`X-GM-MSGID` ([`imap.rs:1786`](../../meron-core/src/imap.rs)) | No exposat per IMAP | Per missatge |
| Exchange (EWS) | `item:Categories` a l'element, més una llista mestra de categories a la bústia | Sí, a la llista mestra | Per element |
| IMAP genèric | Paraules clau (RFC 3501 §2.3.2), només utilitzables si la resposta `PERMANENTFLAGS` del servidor inclou `\*` | No | Per missatge |

L'etiqueta d'Oreneta és per **conversa**; el concepte de cada servidor és
per **missatge**. A més, el magatzem és ara mateix un `{id, name, colour}`
pla sense cap camp per compte: l'esquema ha de créixer, no només la lògica
de sincronització.

El nucli ja reconcilia l'estat remot de `\Seen`/`\Flagged` mitjançant
CONDSTORE ([`sync_flags`, `imap.rs:941`](../../meron-core/src/imap.rs)), que
és el punt d'extensió existent que aquest disseny segueix en lloc
d'inventar-ne un. El `starred` d'Exchange ara mateix és `false` fix al codi,
amb un comentari que explica que el camí de sincronització encara no
demana la propietat MAPI subjacent
([`exchange.rs:2040`](../../meron-core/src/exchange.rs)): el treball de
categories de la fase 6 del pla aprovat és el lloc natural per a tancar
també aquest buit, ja que tots dos són casos de «el camí de sincronització
ha de demanar una propietat més».

## Decisió

**Opció A: una etiqueta local pot portar un vincle opcional a un concepte
remot, per compte, coincident pel nom. El vincle és opcional i s'activa
explícitament: una etiqueta no vinculada es comporta exactament com avui.**

### Model de dades

`Label` guanya un mapa `links: Record<accountId, RemoteLink>` (buit per
defecte). Un `RemoteLink` indica a què està lligada l'etiqueta en aquell
compte: un nom d'etiqueta de Gmail, un nom de categoria d'Exchange (i el
seu GUID un cop creada a la llista mestra de la bústia) o un àtom de
paraula clau IMAP. Una etiqueta sense entrada per a un compte és purament
local en aquell compte, sense cap canvi de comportament.

La vinculació és explícita, no automàtica: la indicació anterior del
mantenidor ("Depende de O-02" al pla de treball aprovat) tracta la
coincidència pel nom com una acció única que l'usuari fa per compte
—«vincula aquesta etiqueta a l'etiqueta de Gmail amb el mateix nom»—, no
com una heurística en segon pla que fusiona en silenci dues etiquetes amb
el mateix nom però sense relació. La interfície exacta de vinculació és una
qüestió de disseny per a una incidència posterior; aquest ADR només fixa
què *significa* el vincle un cop creat.

### Contracte d'assignació i lectura

- **Assignar** una etiqueta vinculada a una conversa l'escriu a **cada
  missatge del fil** al compte vinculat. Una etiqueta és per conversa
  localment i per missatge remotament; no hi ha cap unitat remota més
  petita on escriure sense inventar-ne una que el servidor no té.
- **Llegir** la pertinença d'una etiqueta vinculada en una conversa és la
  **unió** dels missatges del fil: si qualsevol missatge del fil porta
  l'etiqueta, la categoria o la paraula clau remota, la conversa mostra
  l'etiqueta local. Això reprodueix com `unread`/`starred` ja s'agreguen
  avui per fil.
- **Desassignar** una etiqueta vinculada la treu de cada missatge del fil
  que la porta en aquell moment.

### Regles de conflicte

- La **pertinença** (si aquesta etiqueta és en aquesta conversa) la decideix
  el servidor a cada sincronització, amb la mateixa regla que `sync_flags`
  ja aplica a `\Seen`/`\Flagged`. Un canvi remot sempre guanya sobre el que
  Oreneta va escriure per última vegada; no hi ha cap mode en què guanyi el
  local.
- El **color** es decideix localment, **excepte a Exchange**, on la llista
  mestra de categories de la bústia té l'autoritat: Exchange és l'únic
  protocol d'aquests que porta realment un color, de manera que
  sobreescriure'l localment faria que tots dos discrepessin sense cap
  manera de reconciliar-los.
- **Crear** un vincle quan l'etiqueta o la categoria remota amb aquell nom
  encara no existeix la crea al servidor (Gmail: una operació d'etiqueta
  propera a un `CREATE` d'IMAP; Exchange: una entrada a la llista mestra de
  categories) en lloc de fallar en silenci en vincular-la.

### Servidors no compatibles

Un compte IMAP simple la resposta `PERMANENTFLAGS` del qual no inclou `\*`
no pot portar un vincle basat en paraules clau: el servidor ha dit al
client, dins del mateix protocol, que no admet marques arbitràries. La
configuració d'Oreneta ha de dir **«No disponible en aquest compte»** per a
aquell compte, explícitament, en lloc d'amagar l'opció de vincle sense cap
explicació o de descartar en silenci l'etiqueta a la sincronització
següent. Una etiqueta que sembla que viatja i no ho fa és pitjor que una
que mai no ho va pretendre, segons el raonament que ja hi ha avui a
`labels.ts`; aquest ADR estén aquest raonament al cas remot en lloc de
contradir-lo.

### Ordre d'implementació

Segons el pla de treball aprovat: **primer Gmail** (fase 2), perquè és el
buit més petit de tancar (la detecció de la capacitat `X-GM-EXT-1` ja
existeix) i la incidència de la interfície de xips d'etiqueta depèn de
tenir com a mínim un protocol que funcioni per a filtrar. **Les categories
d'Exchange i les paraules clau IMAP venen a la fase 6**, juntament amb el
tancament del buit de `starred` sempre fals d'Exchange esmentat abans,
perquè tots dos són el mateix tipus de treball de «el camí de
sincronització ha de demanar una propietat més».

## Conseqüències

- El contracte del magatzem d'etiquetes creix de `{id, name, colour}` a
  incloure un mapa `links` per compte; cada crida existent a `labels.list`
  / `labels.save` / `labels.assign`
  ([`main.rs:2121,2133,2157`](../../meron-core/src/main.rs)) s'ha de
  revisar respecte de la forma nova quan la fase 2 la implementi; aquest
  ADR no la implementa.
- La pertinença d'una conversa a una etiqueta passa a ser, per a les
  etiquetes vinculades, un fet decidit pel servidor i descobert en
  sincronitzar en lloc d'un fet purament local: la interfície ha de poder
  mostrar «aquesta etiqueta s'acaba de treure remotament» de la mateixa
  manera que ja mostra una confirmació de lectura que arriba d'un altre
  client.
- Assignar una etiqueta vinculada a un fil llarg és una escriptura de N
  missatges, no una escriptura d'un sol registre; això té implicacions de
  cost de sincronització i de límits de freqüència (sobretot a Gmail) que ha
  de tenir en compte la incidència d'implementació, no aquest ADR.
- Exchange és l'únic protocol on el color no té autoritat local; queda
  documentat aquí perquè un futur informe d'error del tipus «per què no es
  manté el canvi de color d'aquesta etiqueta» el respongui aquest registre,
  sense haver-lo de tornar a investigar.

## Alternatives considerades

- **B: només importar, no escriure mai.** Més simple i amb menys risc (cap
  camí d'escriptura a la bústia d'un usuari que es pugui fer malament), però
  no lliura «sincronitzar», que era la petició real; rebutjada perquè respon
  una pregunta diferent i més petita que la que es va fer.
- **C: etiquetes per compte, sense concepte local.** Elimina la possibilitat
  d'etiquetar una conversa de manera coherent entre comptes i trenca el
  motor de regles existent, que assigna etiquetes locals
  ([`rules.go`](../../rules.go), `action_label` a
  [`main.rs:4999`](../../meron-core/src/main.rs)); rebutjada, perquè elimina
  una funcionalitat que existeix avui en lloc de només afegir-ne una.
- **Guanya el local en cas de conflicte, en lloc del remot.** Considerada i
  rebutjada: una etiqueta és una metadada sobre correu que l'usuari també
  llegeix en altres clients, i deixar que Oreneta sobreescrigui en silenci
  el que un altre client acaba de definir faria d'Oreneta la nota
  discordant, no la font de veritat.
