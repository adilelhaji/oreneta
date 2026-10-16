# Acceptació repetible del correu (#145, slice #184)

La [matriu](provider-acceptance-matrix.json) fa correspondre cada subprova actual de
`TestIntegrationMailFlow` a 12 resultats per a l'usuari. És un paquet executable
**IMAP/SMTP aïllat**, no una certificació de Gmail, Workspace, Graph ni de la interfície
de Windows. El [registre de paritat](emclient-parity-acceptance.md) conserva els seus
requisits natius/de proveïdor independents. #145 continua oberta per a l'evidència real i
les fixtures/procediments restants; #184 lliura aquesta slice d'informes.

## Execució automàtica i evidència

El job `integration` existent arrenca maddy 0.8 amb ports només de bucle local (loopback)
i dos comptes sintètics (`alice@maddy.test`, `bob@maddy.test`). El seu servidor
d'enviament només lliura a les seves bústies locals; no té cap ruta de lliurament SMTP
remot. Els perfils, la base de dades i la configuració del clauer fan servir la fixture
de prova temporal existent. L'arnès registra la neteja del contenidor i dels perfils. No
calen comptes reals, credencials ni correu de l'usuari. Les fixtures fan servir ID de
correlació generats en temps d'execució; les asseveracions sobre adjunts/MIME són a
`integration_test.go`.

La CI executa la bateria de nou amb `-json -count=1`. L'informador llegeix els
esdeveniments d'aquella execució i escriu `integration-results/report.json`; només aquest
fitxer sanejat es puja com a `isolated-mail-acceptance-<sha>-attempt-<n>`, de manera que
es conserven artefactes separats per a cada reexecució. Els registres de text lliure, les
càrregues útils, les adreces dels comptes, els registres del contenidor i els noms de
prova desconeguts no es copien a l'informe. Els esdeveniments en brut es queden a
l'executor (runner) per a aquest job, no a l'artefacte. La comprovació IDLE separada de
tres execucions continua sent obligatòria; el seu resultat és al job de la CI, no a
l'informe de 12 resultats. Un informe superat per si sol no pot establir que tot el job o
les set bateries requerides s'hagin superat.

L'informe registra el SHA exacte de l'origen, l'URL i l'intent del flux de treball
(workflow), l'estat per prova i els límits real/natiu explícits `not-tested`. Els
informes dels PR fan referència a la ref de fusió provada; el lliurament requereix una CI
nova de main per al commit de fusió real. No reetiqueteu mai evidència d'un altre commit.
L'informe registra la procedència que proporciona la CI; no és una atestació
criptogràfica de l'execució de les proves.

Si falta Docker, la prova d'integració subjacent es pot ometre en local, però no pot
produir un informe d'acceptació superat. L'evidència obligatòria absent, omesa, fallida,
incompleta, reproduïda o mal formada fa fallar l'informador; les fallades de la
bateria/del paquet i altres proves fallides també impedeixen l'èxit. Els informes es
generen en cas de fallada, fins i tot quan falta l'entrada després d'una fallada de
compilació anterior. La prova de cobertura de la matriu rebutja les subproves de correu
no classificades o reanomenades.

Executeu la bateria aïllada en local a Linux amb les dependències de compilació
existents:

```sh
cargo build --manifest-path meron-core/Cargo.toml
mkdir -p integration-results
MERON_KEYRING=off go test -tags 'integration webkit2_41' -json -count=1 -timeout 10m . > integration-results/events.jsonl
```

La invocació de l'informador a la CI és a `.github/workflows/test.yml` i rep de GitHub
l'URL real de l'execució i el SHA provat. Les execucions locals no són evidència de CI; no
vinculeu resultats locals a un URL de flux de treball no relacionat. Les proves de
l'informador i dels casos negatius no requereixen cap servidor:
`node --test scripts/ci/provider-acceptance.test.cjs`.

## Procediment dedicat per a comptes reals (no executat)

Abans de qualsevol execució externa, obteniu una autorització que indiqui el proveïdor,
els comptes dedicats, les operacions i la llista exacta de destinataris de prova
permesos. No es pot fer servir cap bústia de producció ni cap aplicació OAuth de Google
heretada de l'upstream. Mantingueu els testimonis fora del repositori/dels artefactes;
registreu els noms dels àmbits, mai els valors dels testimonis. L'aprovisionament, els
canvis de l'arrendatari (tenant) i l'enviament extern són accions separades, que la CI no
implica.

Registreu per operació: SHA del candidat i hash de l'executable; versions de
l'aplicació/el nucli i del sistema operatiu; tipus de proveïdor/arrendatari; mode
d'autenticació i àmbits concedits; perfil aïllat; estat inicial de carpetes/memòria cau;
ID sintètics d'execució/missatge i SHA256 dels adjunts; resultat esperat; resultat
observat; marques de temps i referència d'evidència censurada; resultat de la neteja.
Identifiqueu els comptes amb àlies de prova a l'evidència conservada.

Feu servir una carpeta dedicada que contingui text pla sintètic, Unicode/quoted-printable,
alternatives HTML, imatges inserides i un adjunt conegut. Creeu prou missatges per
travessar un límit de pàgina del proveïdor i registreu-ne el nombre. Repetiu assumptes
coincidents en dos comptes per posar en evidència errors d'abast. No reutilitzeu correu
real com a fixtures.

| Operació | Procediment i observació esperada | Neteja / límit de fallada |
| --- | --- | --- |
| Lectura i paginació | Llegiu cada fixture i travesseu el límit de pàgina; compareu recomptes, ID, cos i hashes dels adjunts amb l'estat del servidor | Elimineu només les fixtures de l'execució; distingiu el que no és a la memòria cau del que és absent |
| Enviament | Envieu un missatge correlacionat de la prova A a la prova B permesa; registreu el resultat de l'enviament, la recepció independent a B i la còpia d'Enviats del servidor com a tres observacions separades | No reenvieu a cegues un resultat incert; conserveu-ne la correlació i inspeccioneu primer l'estat del servidor |
| Marques/moviments | Canvieu una fixture i observeu-la des d'un client independent; verifiqueu que el correu amb el mateix assumpte a l'altre compte no s'ha tocat | Restaureu la carpeta/les marques originals només per als ID de missatge de l'execució |
| Esborranys/fitxers | Deseu, reinicieu i torneu a obrir; compareu destinataris, cos i hashes dels fitxers; exerciu un desament interromput | Conserveu l'estat incert de l'esborrany fins que es concilii; no deduïu una còpia de seguretat del perfil complet de l'èxit d'un esborrany remot |
| Fora de línia/reconnexió | Desconnecteu només l'entorn de prova; llegiu el correu de la memòria cau i observeu una fallada honesta per a les dades que no hi són; torneu a connectar i compareu els canvis | Restaureu la connectivitat; comproveu duplicats i missatges no enviats/incerts abans de fer més accions |
| Revocació | Revoqueu només la concessió de prova dedicada, observeu l'error del compte i torneu a autoritzar el mateix principal | Requereix una autorització explícita de revocació de la concessió; preserveu els comptes no relacionats |
| Límit de freqüència | Feu servir un mecanisme de prova aprovat pel proveïdor, si n'hi ha; registreu Retry-After i l'absència de tempestes de reintents | No satureu mai un servei real per provocar la limitació; altrament deixeu aquesta fila sense provar i feu referència a la cobertura amb fixtures |

### Límits per proveïdor

- **IMAP/SMTP genèric:** maddy demostra la ruta aïllada de protocol/emmagatzematge, sense
  TLS de producció, OAuth ni les particularitats d'un servidor concret. Les files reals
  requereixen aquestes comprovacions independents; la compatibilitat amb el protocol no
  és una acceptació universal de proveïdors.
- **Gmail per a consumidors i Google Workspace:** execucions separades; registreu el mode
  OAuth o de contrasenya d'aplicació i la política aplicable. Concilieu les etiquetes de
  Gmail amb les carpetes IMAP, Enviats i Paperera al compte autoritzat. Els resultats de
  consumidor no poden certificar les restriccions d'un arrendatari de Workspace. No feu
  servir el client OAuth inclòs a Meron: executeu una compilació `-tags distributable`
  amb un client propietat de l'aplicació
  ([registres](oauth-registrations.md)).
- **Microsoft 365 Graph:** accés delegat només a la bústia de la sessió iniciada
  ([adaptador](graph-mail-integration.md)). La lectura és `Mail.Read`; els canvis de
  missatges (estat de lectura, marques, moure, copiar dins del compte, suprimir) necessiten
  `Mail.ReadWrite` i l'enviament necessita `Mail.Send`, cadascun sol·licitat per separat
  quan la persona l'activa (ADR-0004;
  [canvis](design/graph-message-actions.md),
  [adjunts](design/graph-attachments.md),
  [enviament](design/graph-sending.md)). Una fila real registra els àmbits concedits i el
  principal fixat; activa la safata d'entrada, obre altres carpetes, pagina i llegeix
  cossos i adjunts de la memòria cau; activa els canvis i comprova cadascun amb Outlook
  on the web; envia a un destinatari autoritzat i comprova Elements enviats; després es torna
  a connectar i comprova la invalidació. Les fixtures de bucle local de Rust cobreixen el
  límit de freqüència amb Retry-After, les concessions revocades, l'àmbit, la continuació,
  la cancel·lació, la fallada parcial d'un lot, els enviaments incerts i la reversió de la
  memòria cau; no són execucions reals. Els esborranys remots, els enviaments de més de
  4 MB, l'enviament programat, els calendaris, els contactes i les bústies compartides
  continuen **no compatibles**, no són proves fallides ni superades.

Les files reals de Gmail/Workspace/Graph
continuen `not-tested` fins que hi hagi evidència independent autoritzada.
La instal·lació nativa continua bloquejada en local per Application Control fins al
procés de signatura separat. L'evidència de la CI d'arrencada/zoom a Windows no certifica
els fluxos de correu, la recuperació completa del perfil ni la instal·lació a la màquina
de l'usuari.
