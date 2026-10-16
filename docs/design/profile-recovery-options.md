# Recuperació del perfil: opció B aprovada (#146)

Estat: **opció B aprovada** el 2026-10-05, amb el text literal «Sí, implementar
copia completa local cifrada». Contracte: [ADR-0010](../adr/0010-full-profile-local-recovery.md),
registrat abans d'implementar-lo. L'inventari següent descriu la base prèvia, no
una capacitat ja lliurada. Base de recuperació
inspeccionada: `c40ea260f65b350bc1b5db7ddebb5f514fa0bcbb`; les columnes posteriors
fan servir la taula de configuració existent i no canvien el format de la còpia.

L'ADR 0008 autoritza còpies de la configuració. #113 demana una còpia completa
programada; no són la mateixa capacitat. L'aprovació permet implementar l'abast B
per lliuraments verificats. Cap opció no autoritza publicacions ni serveis
externs. La revisió es limita a codi i dades sintètiques, sense obrir perfils
de l'usuari.

## Inventari i pèrdua que la còpia actual no resol

| Dada | Situació actual | Recuperació des del proveïdor |
|---|---|---|
| Comptes, preferències per compte, configuració global i subscripcions RSS | Inclosos a `BackupData`; les opcions noves com `mailbox_views` també | Configuració local que no es pot deduir completament del proveïdor |
| Contrasenyes i testimonis (tokens) del magatzem de comptes tradicional | Només amb l'opció de secrets i una contrasenya de xifratge; magatzem segur separat a l'escriptori. Els secrets absents o il·legibles es poden ometre encara que es demanin | La reautenticació pot regenerar sessions; no garanteix recuperar contrasenyes antigues |
| Autoritzacions i perfils de Graph | El magatzem (vault) i les taules de perfils de Graph no formen part de la càrrega actual, tampoc marcant els secrets | La reautorització i la reconstrucció requereixen verificació; no s'ha d'afirmar que la còpia restableix Graph |
| Identitats OpenPGP i S/MIME | Metadades incloses; claus privades només amb secrets i xifratge, i si estan disponibles | Les claus privades no es poden reconstruir a partir del correu remot |
| Confiança i certificats d'altri | Taules `pgp_certs`/`smime_certs`, fora de `BackupData` | No s'ha de suposar la reconstrucció de les decisions locals de confiança |
| Correu i estat de sincronització | Taules de missatges i carpetes, excloses | IMAP/EWS/Graph permeten tornar a consultar el que conservi el servidor i autoritzi el compte; no acredita la recuperació de correu eliminat, de dades només locals ni d'una instantània històrica |
| RSS baixat | La còpia conserva les subscripcions, no els articles | El canal pot deixar de publicar articles antics |
| Esborranys de l'editor complet | Text a `localStorage` (`meron-compose-tabs`), fora de la còpia; els adjunts s'exclouen d'aquesta persistència | Només una còpia desada efectivament a Drafts es podrà recuperar del servidor |
| Resposta ràpida | Estat de l'editor i desament remot explícit o automàtic segons el seu flux actual | Un desament pendent o fallit no és una còpia remota confirmada |
| Adjunts i contingut inserit | Fitxers sota el directori de mitjans i memòria cau, més els adjunts de l'editor; fora de `BackupData` | Recuperables només si continuen en un missatge remot accessible; els fitxers locals pendents poden no tenir equivalent |
| Tasques vinculades | Taula `tasks`, exclosa | Locals: no hi ha cap reconstrucció garantida pel proveïdor |
| Etiquetes i associacions | `labels`, `thread_labels`, `label_links`, excloses | Algunes associacions remotes poden tornar; les etiquetes i anotacions locals no se'n dedueixen |
| Regles, plantilles, aprenentatge del correu brossa i prioritat | Taules pròpies, excloses | Estat local que no es pot reconstruir amb el correu remot |
| Enviaments programats i posposats | `scheduled_sends`/`snoozed_threads`, exclosos | Restaurar una programació no ha de reenviar automàticament; els resultats incerts requereixen revisió |
| Persones i fonts de contactes | `people`, adreces electròniques i telèfons i `contact_sources`, exclosos | CardDAV només pot retornar contactes remots confirmats i encara accessibles; no els canvis locals pendents |
| Calendaris i esdeveniments | Taules pròpies, excloses | Depèn del proveïdor i que els canvis estiguin confirmats; les subscripcions no equivalen a dades locals recuperables |

Fonts: [càrrega i aplicació de les còpies](../../meron-core/src/backup.rs),
[esquema local](../../meron-core/src/store/db.rs),
[esborranys de l'editor](../../frontend/src/states/compose.ts),
[mitjans i memòria cau](../../paths.go). En aquesta tasca no s'ha certificat la
reconstrucció real per a cap proveïdor; aquestes proves corresponen a #145/#98.
L'afirmació general del comentari de `backup.rs` que els missatges són
reproduïbles no cobreix els casos locals, eliminats o no confirmats anteriors.

## Opcions presentades i decisió

**A. Mantenir exclusivament la còpia de la configuració.** Conservar l'ADR 0008 i
millorar els avisos sobre les exclusions. Cost d'implementació més baix i fitxers
petits; continua sent necessari tornar a autenticar-se i sincronitzar. Les pèrdues
locals descrites no queden resoltes i #113 continua com a mancança de paritat.
No s'introdueix la programació de còpies completes ni es promet una recuperació
integral.

**B. Afegir una còpia completa local xifrada d'un perfil (recomanada).** Mantenir
l'exportació de la configuració existent com a opció independent. Aprovar el
límit arquitectònic següent abans de dissenyar i implementar els lliuraments:

- Captura coherent del perfil persistit, incloent-hi la base de dades local, els
  esborranys i els fitxers necessaris. Primer cal garantir esborranys i adjunts
  duradors (#39); no s'ha d'anomenar «completa» una còpia que ometi dades locals
  pendents. Coordinar la captura amb les escriptures; no copiar mai a cegues una
  base de dades i els seus fitxers mentre canvien.
- Fitxer amb versió, amb un manifest del contingut i límits de mida i de camins;
  xifratge obligatori perquè conté correu i dades personals. Reutilitzar les
  primitives criptogràfiques existents quan serveixin; no inventar criptografia.
  La contrasenya de la còpia no s'hi desa a dins. Els secrets i les claus privades
  continuen sent una inclusió explícita; el manifest declara les seves exclusions
  i la necessitat de tornar a autenticar-se.
- La base de dades local xifrada no pot dependre de l'antic clauer per obrir la
  còpia: recuperació amb el fitxer i la contrasenya encara que es perdi l'equip
  original. La clau d'emmagatzematge necessària per recuperar les dades es
  distingeix de les credencials opcionals del proveïdor. La tècnica d'exportació i
  de nou xifratge es dissenya i es revisa en el seu lliurament; no es pressuposa
  que n'hi hagi prou de copiar SQLCipher.
- Restaurar i verificar primer en una ubicació aïllada; no sobreescriure el
  perfil actiu durant la lectura i la validació. Les fallades de format,
  contrasenya, integritat, espai o compatibilitat conserven l'original. Activació
  local explícita i reversible; la sincronització queda aturada fins a una
  reconnexió i una reconciliació explícites amb efectes visibles. Restaurar dades
  locals no propaga l'estat antic al servidor: no envia correu ni invitacions ni
  repeteix automàticament escriptures o operacions pendents. No requereix
  gestionar diversos perfils simultanis de #99.
- Compatibilitat inicial amb Windows i amb una versió i un esquema admesos
  explícitament. No s'afirma la portabilitat d'una base de dades d'escriptori cap
  al mòbil. Els formats futurs es rebutgen sense modificar la destinació.
- Primer lliurament manual i local, sense núvol ni supressió automàtica. La
  programació i la retenció s'implementen en un lliurament separat: no activades
  per defecte, amb límits visibles i amb l'última còpia validada protegida. No
  s'eliminen fitxers d'altri ni s'amplia la despesa d'infraestructura.

Cost de B: requereix emmagatzematge addicional del perfil i espai temporal per a
la verificació i la restauració, lectura de fitxers grans i coordinació entre
l'editor, el nucli i el magatzem segur. És més gran que A; no hi ha cap estimació
fiable fins que no es mesuri un perfil sintètic representatiu. Perdre la
contrasenya impediria obrir una còpia xifrada; això s'ha d'explicar en crear-la.
Una còpia no pot recuperar dades que ja no existien ni convertir un enviament
incert en un enviament segur.

## Proves existents i lliuraments posteriors

Les proves de `backup/tests.rs` cobreixen l'anada i tornada de la configuració,
l'absència de correu en memòria cau, els secrets opcionals (opt-in), la
contrasenya incorrecta, la manipulació del xifratge, el format futur, els límits
de la KDF i la fallada parcial amb reversió (rollback) d'**SQLite**. Aquesta
reversió no demostra una reversió atòmica del clauer extern. També hi ha proves
d'errors i d'actualització de l'estat a `frontend/src/states/backup.test.ts`.
Es reutilitzen; no justifiquen afirmar una recuperació completa o nativa.

El 2026-10-05, la bateria Rust de la CI a `c06eff37` va passar (execució
37302492336, job 111738284833), inclosos els 31 casos de `backup::tests`.
L'intent local focalitzat d'aquests tests a Windows no va arribar a executar-los:
compilació E0463 per dependències no trobades a l'entorn Rust local.
No se substitueix aquesta limitació per una afirmació de recuperació nativa.

Es va triar B i es va registrar l'ADR-0010, que només estén el punt de còpies de
seguretat de l'ADR 0008. Cal separar: (1) durabilitat dels esborranys i fitxers,
(2) captura i verificació, (3) restauració aïllada i recuperació d'interrupcions,
(4) programació i retenció. Cada lliurament necessita un contracte concret, tests
sintètics d'èxit, errors i límits, revisió i CI. L'acceptació nativa i els assaigs
per proveïdor són posteriors. #113 continua pendent d'implementació i
d'acceptació; aprovar B no la completa.
