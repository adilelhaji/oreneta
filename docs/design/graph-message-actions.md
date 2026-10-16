# Accions sobre missatges a Microsoft Graph (#141)

Implementació sota l'[ADR-0004](../adr/0004-microsoft-graph.md). L'ADR ja
aprova demanar `Mail.ReadWrite` de manera incremental; aquest document fixa el
contracte de cada operació, la concurrència i la reconciliació de la memòria
cau. No introdueix cap identitat nova ni cap estat persistent nou: l'única dada
afegida és el nivell concedit, dins del marcador de concessió que ja existia.

## Permís

- **Per defecte, només lectura.** L'activació continua demanant `Mail.Read`.
  Les escriptures es demanen a part, en una autorització explícita per a aquell
  compte («Permet els canvis»), que sol·licita `Mail.ReadWrite`. Res no demana
  `Mail.Send`.
- **Mana el que s'ha concedit.** El nivell és el que retorna Microsoft, no el
  que s'ha demanat. Si l'inquilí (tenant) retalla el permís, el compte continua en
  només lectura i la interfície ho indica.
- **Rebutjar o cancel·lar** l'autorització de canvis no toca la concessió
  existent: la lectura continua igual.
- **Renovació.** Es demana el mateix nivell que es tenia. Si Microsoft rebutja
  la renovació amb escriptura (consentiment retirat o denegat), s'intenta una
  vegada amb lectura. Si funciona, el compte queda en només lectura i
  s'indica; si no, és una reautenticació com fins ara. La memòria cau sense
  connexió es conserva en tots dos casos.
- **Marcador.** El paràmetre no secret `graph.grant.<clau>` ara desa
  `{"writes": bool}`. Els marcadors antics (`true`) compten com a només
  lectura. És una comprovació prèvia per no tocar la memòria cau local:
  l'autorització real és la concessió al clauer, que es torna a comprovar a
  cada sol·licitud.

## Operacions

Cada operació porta `Prefer: IdType="ImmutableId"`, sense redireccions, amb el
mateix límit de temps i la mateixa classificació d'errors que la lectura, i
sense llegir mai el cos d'un error.

| Acció | Sol·licitud | Èxit |
|---|---|---|
| Llegit / no llegit | `PATCH /me/messages/{id}` amb `{"isRead": b}` | 200 |
| Marca / sense marca | `PATCH /me/messages/{id}` amb `{"flag": {"flagStatus": "flagged" \| "notFlagged"}}` | 200 |
| Moure | `POST /me/messages/{id}/move` amb `{"destinationId": carpeta}` | 201 |
| Copiar (el mateix compte) | `POST /me/messages/{id}/copy` amb `{"destinationId": carpeta}` | 201 |
| Suprimir | moure a la carpeta amb el rol `deleteditems` | 201 |
| Suprimir definitivament | `DELETE /me/messages/{id}`, només des d'Elements suprimits o Esborranys | 204 |
| Moure una carpeta (#210) | `POST /me/mailFolders/{id}/move` amb `{"destinationId": carpeta o arrel}` | 200/201 amb el pare demanat |

- **Suprimir** és recuperable: va a Elements suprimits, igual que a IMAP va a la
  paperera. **Suprimir definitivament** només passa des d'Elements suprimits o
  Esborranys, com a IMAP. Graph el deixa a «Elements recuperables», fora de la
  vista del client.
- **Copiar a un altre compte** des de Graph o cap a Graph, buidar una carpeta,
  marcar-ho tot com a llegit, crear o suprimir carpetes, desar com a `.eml`,
  etiquetes remotes i esborranys remots continuen sense suport. Es rebutgen
  abans de qualsevol efecte local. L'enviament és a
  [graph-sending.md](graph-sending.md).
- **Moure una carpeta** ([ADR-0057](../adr/0057-graph-folder-moves-and-receipt-reports.md)):
  - les regles de l'ADR-0050 es comproven sobre l'arbre desat
    (`graph_folders`), per id i pare: ni carpetes especials ni les que les
    contenen, ni carpetes de cerca, ni dins de si mateixa, ni allà on ja és, ni
    al costat d'una altra amb el mateix nom (sense distingir majúscules);
  - una sol·licitud, que no es repeteix mai. Després es torna a llegir l'arbre,
    tant si ha anat bé com si ha anat malament o hi ha dubte. Sense resposta,
    amb 5xx o amb un èxit que no indica el pare demanat, el resultat és incert,
    mai «no s'ha mogut»; la interfície torna a llegir la llista i, si es torna
    a demanar, troba la carpeta al seu lloc («ja hi és», com a informació),
    sense segona sol·licitud;
  - amb identificadors immutables la carpeta conserva el nom local; si Graph
    retorna un altre id, s'informa com a reanomenament.
- **Desfer** és l'acció inversa, que passa pel mateix camí que l'original:
  - llegit i marca es fixen al valor anterior;
  - moure i suprimir a la paperera es desfan movent-ho de tornada. Amb
    identificadors immutables el missatge conserva el seu identificador i el
    seu UID local després de moure's (provat a la reconciliació);
  - si ja no és on s'havia deixat, el desfer falla com qualsevol moviment,
    sense tocar res;
  - suprimir definitivament no es pot desfer.

## Conjunt revisat i concurrència

- Els missatges es resolen als seus identificadors de Graph en una sola lectura
  de la base de dades, abans de la primera sol·licitud. La resolució es fa per
  compte, carpeta i UID local. Un missatge arribat després o d'un altre compte
  no pot entrar al lot. Si un UID ja no és en aquella carpeta, el lot no
  comença.
- **Un a un.** Les sol·licituds van una darrere l'altra. El primer error atura
  el lot: no es continua colpejant un servidor que limita (429) ni una
  concessió revocada (401/403).
- **Resultat del lot.** Un lot parcial retorna quantes se n'han aplicat de
  quantes i el motiu de l'aturada, amb `Retry-After` si n'hi ha hagut. No es
  presenta mai com un èxit total.
- **Errors.** 403 és «sense permís», 404 «ja no existeix», 409/412 «conflicte»
  i 429 «limitat», amb l'espera indicada.
- **Resultat incert.** Si la connexió falla després d'enviar la sol·licitud, el
  resultat és «incert». No es repeteix sola:
  - moure, copiar i suprimir no són idempotents;
  - llegit i marca sí que ho són, i l'usuari les pot repetir expressament.

## Reconciliació de la memòria cau

- **Llegit i marca.** La memòria cau local s'actualitza per a cada missatge
  confirmat, també en un lot parcial. El delta següent porta el mateix valor.
- **Moure, copiar i suprimir.** Després del lot, sigui complet, parcial o
  incert, se sincronitzen per delta la carpeta d'origen i la de destinació.
  Així la memòria cau reflecteix el que hi ha al servidor i no el que s'ha
  intentat. Amb identificadors immutables, un missatge mogut conserva el seu
  identificador i el seu UID local.
- **Error de reconciliació.** Si la reconciliació falla, per exemple per un
  límit, l'acció no es converteix en error. La sincronització normal següent
  la completa.
- **Dades locals.** Les etiquetes locals i els esborranys locals no es toquen.
  IMAP i EWS no canvien. Graph no recorre mai a IMAP, SMTP ni EWS.

## Informes de lliurament i de lectura (#210)

- Un missatge sense adjunts es llegeix del seu JSON, que en un informe només
  porta el text per a persones. Per això `GET /me/messages/{id}` demana també
  la classe de l'element (`$expand=singleValueExtendedProperties($filter=id eq
  'String 0x001A')`). Si és `REPORT.*` (`IPM.Note.NDR`, `DR`, `IPNRN`,
  `IPNNRN`), se'n llegeix el MIME i el nucli l'interpreta com qualsevol altre
  informe (ADR-0057). Si el MIME és massa gran, es mostra el text.
- En sincronitzar una carpeta, una consulta per classe d'element (`$filter`
  sobre `singleValueExtendedProperties`, `$select=id`) se segueix pàgina a
  pàgina per `@odata.nextLink` (validat com qualsevol enllaç de pàgina; fins a
  10 pàgines), saltant els informes ja llegits, i es llegeix el MIME de fins a
  20 de nous, també els desats abans; cadascun, una sola vegada. Un que falla
  per si mateix (massa gran, ja no hi és, il·legible) es marca amb el motiu i
  no frena els altres; un error del servidor o del compte atura el recorregut
  fins a la sincronització següent. Es fa tant com es pot, sense garantia: si la consulta falla,
  els informes es llegeixen en obrir-los.

## Interfície

- Un compte de Graph sense permís de canvis es comporta com fins ara: les
  accions d'escriptura estan inhabilitades, també amb el teclat i en lot.
- Amb permís, s'habiliten llegit, marca, moure, suprimir i copiar dins del
  compte, i moure carpetes. Sense permís, moure una carpeta indica «Permet els
  canvis d'aquest compte a la seva configuració per moure'n les carpetes». El
  que continua sense suport (buidar una carpeta, crear o suprimir carpetes,
  `.eml`) continua inhabilitat.
- La configuració del compte mostra el nivell concedit i ofereix «Permet els
  canvis» o, si s'ha perdut, el motiu.

## Proves

- **Transport** (servidor de bucle local):
  - mètode, camí, capçaleres i cos de cada sol·licitud;
  - 200/201/204 com a èxit;
  - 401/403/404/409/412/429 amb `Retry-After` i 5xx classificats;
  - tall de connexió com a incert;
  - id de resposta aliè com a resposta no vàlida;
  - una concessió sense `Mail.ReadWrite` no envia res;
  - moure una carpeta: camí, destinació, pare confirmat, errors i resposta
    perduda com a incerta, enviada una vegada (#210);
  - la lectura d'un missatge només en demana la classe; `REPORT.*` és un
    informe.
- **Sessió** (`Source` simulat):
  - resolució prèvia del conjunt, sense UID d'una altra carpeta;
  - aturada al primer error, amb recompte;
  - actualització local de llegit i marca en un lot parcial;
  - reconciliació per delta després de moure i suprimir;
  - el resultat incert no es repeteix;
  - moure una carpeta: regles abans d'enviar, arbre rellegit després d'un
    èxit, d'un rebuig o d'un dubte, i un reintent després del dubte no envia
    una segona sol·licitud;
  - un informe sense adjunts es llegeix del seu MIME.
- **Autorització:**
  - flux de canvis amb l'abast demanat;
  - nivell desat segons el que s'ha concedit;
  - renovació que conserva el nivell o passa a lectura;
  - marcador `writes`.
- **Distribució:**
  - el guardià només deixa passar les accions admeses en comptes amb permís;
  - un compte sense permís continua rebutjant abans dels efectes locals;
  - copiar entre comptes continua rebutjat.
- **Pont i interfície:** `oauth.graphBegin` amb `writes` i habilitació de les
  accions segons el nivell.
- **Proveïdor real:** la certificació amb un inquilí real queda a #98.
