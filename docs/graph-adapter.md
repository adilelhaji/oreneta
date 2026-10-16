# Lliurament de Microsoft Graph

Direcció aprovada: [ADR-0004](adr/0004-microsoft-graph.md), #46.
Primera implementació: #125 a `meron-core/src/graph` (biblioteca nativa compartida).

## Disponibilitat

X1 és un adaptador de lectura Rust invocable. X2 hi afegeix l'autorització backend/navegador
i el cicle de vida aïllat de les credencials a [graph-authorization.md](graph-authorization.md).
Graph **encara no és una opció de compte activa**: #128 és responsable de la interfície, la sessió de correu
i la projecció a la memòria cau. Cap de les dues slices modifica les concessions IMAP/SMTP/EWS existents ni
envia correu. Aquests canvis no substitueixen cap executable ni instal·lador.
L'acceptació amb proveïdors reals continua oberta.

| Capacitat | X1 | Àmbit delegat necessari |
|---|---|---|
| Carpetes arrel / fills immediats | Lectures tipades i paginades | `Mail.ReadBasic` |
| Missatges de carpeta / missatge individual | Lectures tipades, sense l'efecte secundari de marcar com a llegit | `Mail.Read` |
| Delta de missatges de carpeta | Canvis parcials/làpides i punts de control amb abast | `Mail.Read` |
| Edició/moviment/supressió/esborranys | No implementat | Més endavant `Mail.ReadWrite` |
| Enviament i recuperació d'enviaments incerts | No implementat | Més endavant `Mail.Send` |
| Sincronització de calendari/contactes | No implementat | Més endavant, consentiment per funció |
| Bústies compartides / núvols nacionals | X1 no ho habilita | Slice de capacitat separada |
| CRUD genèric de carpetes públiques / bústies de grup | Mancances de paritat conegudes de Graph | El consentiment no ho resol |

`Grant` ha de rebre un testimoni de Graph, els àmbits **retornats pel proveïdor**, la caducitat i la
vinculació de compte verificada de la integració OAuth d'X2. El seu constructor Rust
públic no és un validador de testimonis: l'amfitrió OAuth ha de validar l'emissor,
el compte i l'audiència abans de construir-lo. Cap concessió/testimoni/punt de control no es
serialitza ni s'exposa pel pont del frontend. No hi ha sortida de depuració per a les concessions;
la sortida de depuració dels punts de control omet l'URL. Les comprovacions d'àmbit distingeixen majúscules i minúscules i no
equiparen els àmbits del recurs d'Outlook, els només d'aplicació o els compartits amb l'accés a `/me`.

## Contracte de lectura i recuperació

- HTTP bloquejant pel servidor intermediari (proxy) resolt per a cada compte; els invocadors asíncrons han de
  fer servir `spawn_blocking`. Punt final (endpoint) global fix de Graph v1.0; límit de 30 segons per petició,
  límit de resposta de 4 MiB, com a màxim 1.000 elements retornats per pàgina. Els resultats massa grans o
  mal formats fallen, mai no es trunquen en silenci. La preferència `$top` / mida màxima de pàgina
  en demana 100; els consumidors continuen amb el punt de control proporcionat.
- Una pàgina per crida; les carpetes arrel **no** són tota la jerarquia. Els consumidors
  recorren explícitament les carpetes filles i han de limitar/cancel·lar el seu propi recorregut.
  Els errors HTTP no desencadenen reintents ni esperes. Retry-After es retorna intacte
  (segons o data HTTP); un retard absent continua sent desconegut, no zero.
- Els identificadors inclouen el compte i el tipus i conserven les majúscules. Les peticions d'elements inclouen la
  preferència d'identificador immutable. No s'han de convertir en UID locals ni deduir-ne la identitat a partir de l'assumpte.
- Els punts de control són en memòria, opacs i vinculats exactament al compte/col·lecció.
  Es rebutgen els orígens externs, els canvis de protocol, les dades d'usuari (userinfo), els fragments, els canvis de bústia/col·lecció
  i les redireccions. S'accepten les grafies equivalents documentades `/mailFolders/id`
  i `/mailfolders('id')` sense canviar les majúscules de l'identificador ni
  els valors de consulta del proveïdor. `percent-encoding` ja el resolia `url`;
  declarar-lo directament no afegeix cap paquet resolt nou.
- Un punt de control de pàgina següent indica que la ronda és incompleta; un punt de control delta
  la tanca. X1 mai no confirma un punt de control ni suprimeix dades. Els consumidors han de
  detectar cicles de recorregut repetits i desar de manera atòmica els canvis aplicats amb
  el punt de control completat a la slice de projecció posterior. Una làpida (tombstone) és un
  canvi del proveïdor, no una ordre per suprimir dades no relacionades o només locals.
- Els camps de missatge parcials conserven `None` en lloc de fabricar valors falsos/buits.
  L'HTML en brut ha de passar pel sanejador existent abans de representar-se.
- Els errors només exposen categories/estat/retard definits localment, mai cossos del
  proveïdor, testimonis bearer ni URL de punts de control. 401 requereix tornar a autenticar-se;
  403 és política/accés denegat (no necessàriament manca de consentiment); 410 requereix
  tornar a sincronitzar; 429 és limitació de peticions; 5xx és no disponible. Els altres estats inesperats i
  les pàgines mal formades es tanquen en cas d'error (fail closed). Les rutes de correu existents no canvien.

## Properes slices d'implementació

1. #127: OAuth/PKCE i autorització explícita per compte; concessió Graph segura i diferenciada,
   verificació dels àmbits retornats i proves de cancel·lació i de renovació/revocació.
2. #128: projecció de Graph a la memòria cau qualificada per compte, confirmació/recuperació delta, preservació
   d'esborranys/etiquetes locals i activació explícita i integració amb la interfície i la sessió (#24/#25).
3. Escriptures, adjunts, actualitzacions condicionals i cicle de vida d'enviament conciliat.
4. Calendari/contactes i capacitats delegades; acceptació amb proveïdors/nativa.

Les proves de fixture/bucle local (loopback) d'X1 s'executen al job de CI de Rust existent, fora de línia respecte de
Microsoft. Proven el comportament del protocol, no l'autorització d'un tenant real ni la
representació a Windows/WebView2. #46 i el programa de paritat continuen oberts.
La fixture de bucle local canvia explícitament els sòcols acceptats a mode bloquejant
(Windows hereta el mode de l'escoltador), i el seu cas de servidor intermediari completa CONNECT
abans de llegir el GET tunelitzat. La fallada de transport fa servir una connexió pròpia,
no un port efímer alliberat. Ordre local:
`cargo test --locked --manifest-path meron-core/Cargo.toml --lib graph::`.

Fonts verificades el 2026-09-09:
[API de carpetes](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0),
[delta](https://learn.microsoft.com/en-us/graph/delta-query-messages),
[mancances de Graph / calendari d'EWS Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online).
