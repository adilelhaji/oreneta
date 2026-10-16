# ADR-0058: Exchange (EWS): moure carpetes, confirmació de lliurament, llistes de distribució i tasques

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #211 i va demanar l'opció més prudent); pendent de revisió del
  propietari al final del pla.
- Data: 2026-10-15.
- Abast: #211, la part d'Exchange (EWS) de quatre files de la paritat
  amb eM Client 10.4: SET-07 (#87, moure carpetes), SET-11 (#107,
  confirmació de lliurament), SET-19 (#41, grups de contactes) i SET-20
  (#103, tasques). Sobre ADR-0012, ADR-0013, ADR-0039, ADR-0048, ADR-0050,
  ADR-0052 i ADR-0053. Microsoft Graph en queda fora (#210), i també
  l'evidència amb un servidor Exchange real (l'execució N5 final).

## Context

L'adaptador EWS ja llegia i movia correu, el calendari, el directori i la
resposta automàtica. Li faltaven quatre coses que IMAP, CalDAV i CardDAV
ja tenen: moure una carpeta, demanar confirmació de lliurament, els grups de
contactes i les tasques. El crate `ews` (bifurcació pròpia) modela
`MoveFolder` i `IsDeliveryReceiptRequested`, però dona a tots els elements
una sola forma (`Message`) sense membres, data de venciment ni estat de
tasca, i no es pot canviar sense publicar una versió nova del crate.

## Decisió

### 1. Moure carpetes (SET-07)

- **Les carpetes d'EWS s'anomenen per la seva ruta.** Fins ara el nom de
  transmissió d'una carpeta era només el seu nom, de manera que «Bandeja de
  entrada/Clientes» era `Clientes`, totes sortien al nivell superior i dues
  subcarpetes amb el mateix nom es trepitjaven. Ara el nom és la ruta
  des de l'arrel de la bústia, amb `/` com a IMAP: `INBOX/Clientes`,
  `Proyectos/2026`. L'arrel no es llista; una carpeta el pare de la qual no
  és a la llista (l'arrel, o una carpeta d'una altra classe) comença una
  ruta. Una carpeta de servei que no és de correu continua sense llistar-se,
  però sí que dona el seu lloc a les seves que ho són. Una cadena de pares
  que torna sobre si mateixa (error del servidor) es talla on es repeteix.
- **Una `/` dins d'un nom d'Exchange** s'escriu com a `∕` (barra de
  divisió, U+2215), que es llegeix igual: Exchange l'admet en un nom i la
  ruta la fa servir entre noms. Perquè dos noms no donin mai el mateix
  (`A/B` i `A∕B`), una `∕` que ja és al nom s'escriu `\∕` i una barra
  inversa `\\`: cada tram es torna a llegir com un sol nom. Com que
  els noms per ruta arriben amb aquest mateix canvi, no hi ha noms
  desats amb una altra forma que calgui convertir.
- **Tot el que s'ha desat amb el nom antic segueix la seva carpeta.** En
  llistar, el que estava desat amb el nom d'abans (sense ruta) d'una carpeta
  que era l'única amb aquest nom, i la ruta de la qual encara no té res,
  passa a la ruta nova en una transacció, igual que en un moviment:
  missatges, estat de sincronització, ids d'Exchange, converses ajornades,
  tasques fetes d'una conversa, el registre de les regles, el progrés
  de l'arxivament automàtic, les regles del compte que hi mouen correu
  i la política d'arxivament automàtic (que continua confirmada: anomena les
  mateixes carpetes). No es torna a baixar res. Una prova recorre totes
  les columnes que anomenen una carpeta i falla si n'hi ha una de nova que
  no està decidida (`folder_move::FOLDER_REFERENCES` o `NOT_MAIL_FOLDERS`).
  Les regles «per a tots els comptes» conserven el seu nom: anomenen una
  carpeta de cada compte, i canviar-lo per a un trencaria els altres.
- **La interfície també ho segueix.** Els canvis de nom queden desats
  (`folder_renames`) fins que la interfície demana la llista de carpetes, que
  els porta (`renames`, com en moure); les preferides, els colors, les
  columnes dels taulers, les cerques desades, la carpeta oberta i l'última
  oberta els segueixen. No es treu cap preferida.
- **Un nom que tenien diverses carpetes** (`Archivo` a dalt i
  `Bandeja de entrada/Archivo`) barrejava les dues a la memòria cau:
  s'esborra aquesta memòria cau i totes dues es tornen a llegir. Tot això
  passa una sola vegada per compte, la primera vegada que se'n llisten les
  carpetes amb aquesta versió (`ews_folder_paths`); després, una carpeta
  nova que es diu com una altra és només una carpeta nova. El que anomenava
  aquest nom es queda en la que continua dient-se així, o deixa de trobar
  la seva carpeta: no es pot saber quina era.
- **Un estat de sincronització que el servidor ja no accepta**
  (`ErrorInvalidSyncStateData`) torna a començar la carpeta, una vegada.
- **Moure és `MoveFolder`** amb l'id de la carpeta i el del pare nou
  (o l'arrel de la bústia, `msgfolderroot`, per al nivell superior); les
  subcarpetes i els elements van amb ella. Les regles d'ADR-0050 són les
  mateixes (`folder_move::plan_folder_move` sobre la llista desada).
- **Abans de moure es torna a llistar la jerarquia.** Si la carpeta ja no
  és on deia la memòria cau (moguda, reanomenada o suprimida en un altre
  client), si la destinació ja no existeix o si allà ja hi ha una carpeta
  amb aquest nom, no es mou res i es demana actualitzar. És la regla
  d'ADR-0012 aplicada a carpetes: no actuar mai sobre una imatge de la
  bústia que ja no és certa.
- **No es repeteix mai.** Abans d'enviar-lo es desa el moviment amb l'id
  de la carpeta i tots els seus canvis de nom (`ews_uncertain_moves`). Si
  el servidor respon, el registre s'esborra (fet, o rebutjat: no es va
  moure res). Si la resposta es perd, la sessió oblida la seva llista i la
  lectura següent de carpetes cerca la carpeta pel seu id: si és a la
  ruta nova, tot el que s'ha desat amb els noms vells la segueix, com
  després d'un moviment respost, i la interfície se n'assabenta; si és on
  era, no es va moure; en tots dos casos el registre s'esborra.
- La interfície permet moure carpetes en comptes d'Exchange, amb les
  mateixes regles que IMAP; Graph les mou per id des d'ADR-0057 (#210).

### 2. Confirmació de lliurament (SET-11)

- Exchange rep el missatge com a MIME (`CreateItem` amb `MimeContent` i
  `SendAndSaveCopy`), sense sobre SMTP. La petició va en el mateix element,
  al costat del contingut: `IsDeliveryReceiptRequested` = `true`. Les
  propietats de l'element s'apliquen sobre el MIME.
- Només s'escriu si qui envia l'ha demanada (ADR-0048: l'interruptor del
  redactor, que comença amb el paràmetre global). Sense demanar-la, la
  petició al servidor no canvia en res.
- L'enviament respon `delivery_receipt: "requested"` per a Exchange: la
  petició va en la sol·licitud. Que un servidor Exchange real l'atengui
  al costat del MIME encara no està comprovat (N5); fins aleshores la
  documentació diu «es demana en la sol·licitud» i la interfície no promet
  res més. L'enviament passa pel mateix camí que Graph
  (`send_mime_with_receipt` i `receipts::delivery_receipt`, ADR-0057):
  Exchange sempre porta la petició; Graph, on ADR-0057 ho permet, i
  si no, respon `"unsupported"` amb el motiu.
- La confirmació de lectura continua a la capçalera MIME
  (`Disposition-Notification-To`), com deia ADR-0048; no es duplica a
  `IsReadReceiptRequested`.
- Els avisos de lliurament i de lectura que arriben s'interpreten per a tots
  els comptes, Exchange inclòs, des d'ADR-0057 (#210).

### 3. Llistes de distribució com a grups de contactes (SET-19)

- **Una llibreta per compte d'Exchange** (`exchange-<cuenta>`, tipus
  `exchange`), com la de Google: s'obté des de Paràmetres → Persones amb
  «Llegir els contactes d'Exchange» i es torna a llegir com les altres. Fa
  servir l'inici de sessió del compte; no desa cap contrasenya pròpia. Se'n
  va amb el compte.
- **Persones:** els contactes de la carpeta Contactes (no les seves
  subcarpetes), de només lectura, com diu ADR-0012 per a Exchange. El nom,
  el nom de pila, el cognom, l'empresa, les adreces (sense prefix `SMTP:`; un
  identificador de directori `/O=…` no és una adreça) i els telèfons.
- **Grups:** cada llista de distribució de la carpeta és un grup
  (ADR-0052). Els seus membres:
  - un contacte de la carpeta, pel seu id d'element, que és l'UID de la
    persona a la llibreta;
  - algú que no és contacte aquí (una adreça escrita o una entrada
    del directori) es desa com a `mailto:<dirección>` amb el nom i
    l'adreça que va donar el servidor (columnes noves `name` i `addr` de
    `contact_group_members`, esquema 65). Es veu en el grup i el redactor
    l'expandeix igual que un contacte. Sense això, una llista feta amb el
    directori de l'organització (el més habitual) es veuria buida;
  - una entrada sense adreça utilitzable (una llista dins de la llista, un
    identificador de directori) no es mostra, però continua a la llista.
- **Escriure** (crear, reanomenar, afegir o treure membres, suprimir), amb
  la regla d'ADR-0012:
  - es llegeix la llista del servidor; si la seva clau de canvis
    (`ChangeKey`) no és la llegida, no s'escriu res i es retorna la còpia
    d'allà;
  - s'envia només la diferència sobre el que l'editor veia: el nom si
    ha canviat (`SetItemField`), els membres nous (`AppendToItemField`) i
    els que es treuen, per la clau que el servidor va donar a cadascun
    (`DeleteItemField` sobre `distributionlist:Members:Member`). Un membre
    que l'editor no veia no es toca;
  - l'escriptura porta la clau llegida i
    `ConflictResolution="NeverOverwrite"`: un canvi fet entre la lectura
    i l'escriptura el rebutja el servidor
    (`ErrorIrresolvableConflict`) i es retorna la còpia d'allà;
  - suprimir una llista l'envia a Elements suprimits, després de comprovar
    la seva clau com més amunt (`DeleteItem` no compara claus);
  - després d'escriure es torna a llegir la llista i es desa tal com ha
    quedat; un conflicte també desa aquí la còpia d'allà (o treu la llista
    si ja no hi és), de manera que «torna-la a mirar i reintenta-ho» parteix
    d'ella;
  - no s'escriu mai sense la clau llegida: sense ella no s'envia res i és un
    conflicte.
- **Límit acceptat:** crear una llista no és idempotent. Si la resposta a
  la creació es perd, la llista pot quedar creada al servidor i
  aparèixer en la lectura següent de la llibreta; tornar-la a crear a mà
  en faria una segona. Les llistes no tenen on desar un id nostre que es
  pugui cercar, com les tasques, i cercar per nom confondria dues llistes
  que es diuen igual.
- Un grup d'Exchange només pot tenir persones de la mateixa llibreta, com
  un de CardDAV. Un membre nou que és contacte s'escriu pel seu id i la seva
  primera adreça; una persona sense adreça no hi pot entrar.

### 4. Tasques (SET-20)

- **Una llista per compte d'Exchange**, enllaçada a la seva carpeta Tasques:
  «Tasques d'Exchange de <compte>» a la visualització de Tasques. Columna nova
  `task_lists.ews_account` (esquema 65). Es llegeix sencera abans d'afegir-la;
  si falla, no s'afegeix. Se'n va amb el compte (i les seves tasques). La
  resta del model és el d'ADR-0039: canvis aquí primer, marcats com a
  pendents; se sincronitza en obrir Tasques i amb «Sincronitzar».
- **Correspondència de camps:** `Subject` ↔ títol; `Body` en text ↔ nota;
  `Importance` ↔ prioritat (baixa, normal, alta); `DueDate` ↔ data límit,
  que a Exchange és una data sense hora: es llegeix el dia que anomena, en la
  zona en què Exchange va escriure la seva mitjanit (com els esdeveniments de
  dia sencer), i és la mitjanit d'aquí; s'escriu com a `AAAA-MM-DDT00:00:00Z`.
  Una hora de venciment posada aquí no viatja: Exchange no la desa.
  `Status` `Completed` amb `CompleteDate` ↔ completada (mai una data
  futura, que Exchange rebutja); reobrir escriu `NotStarted`.
  `ReminderIsSet` i `ReminderDueBy` ↔ recordatori.
- **Escriure només el que ha canviat:** es desa la còpia del servidor tal com
  es va llegir, i una edició envia només les propietats que difereixen
  (`SetItemField`/`DeleteItemField`). El que un altre client va posar i aquí
  no es veu (categories, feina, propietari) no es toca.
- **Conflictes (ADR-0012, ADR-0039):** cada escriptura porta la clau de
  canvis llegida i `NeverOverwrite`. Un rebuig marca la tasca en conflicte
  i atura la cua de la llista; la lectura marca en conflicte una tasca
  canviada als dos costats o canviada aquí i suprimida allà. «Conservar la
  meva» torna a posar la tasca a la cua sobre la versió d'allà (o la torna
  a crear); «Utilitzar la del servidor» pren la d'allà. Suprimir comprova la
  clau abans, perquè `DeleteItem` no ho fa. No s'escriu mai sense la
  clau llegida: sense ella és un conflicte i no s'envia res.
- **Un canvi que Exchange no acceptaria mai** («cada N anys» amb N > 1, una
  regla sense venciment) se sap abans d'enviar: aquesta tasca queda apartada
  amb el motiu (`rejected: …`) i les altres de la llista continuen. Es torna
  a intentar quan la tasca canvia. L'editor tampoc no ofereix «cada N anys»
  en una llista d'Exchange.
- **Lectura per pàgines** en ordre de creació; el desplaçament compta
  tot el que el servidor llista (la carpeta pot tenir altres coses) i una
  tasca llistada dues vegades és una. Com que les pàgines per desplaçament
  poden saltar-se una tasca si una altra desapareix entre dues pàgines, una
  tasca coneguda aquí que la lectura no ha portat es demana pel seu id abans
  de donar-la per suprimida; només se suprimeix aquí si el servidor diu que
  no existeix. Cada llista se sincronitza d'una en una;
  llistes diferents no s'esperen.
- **Sense duplicats en reintentar:** abans de crear una tasca es desa aquí
  un id nostre (`remote_href = new:<uuid>`) i s'escriu a la tasca com a
  propietat amb nom (`PublicStrings`, `OrenetaTaskUid`). Si la resposta
  es perd, l'intent següent cerca aquest id (`FindItem` amb
  restricció) i adopta la tasca que troba en lloc de crear-ne una altra; la
  lectura completa fa el mateix. És l'equivalent de decidir
  l'adreça abans d'enviar a CalDAV (ADR-0039).
- **Repetició (ADR-0053), on EWS l'admet:** diària, setmanal (un o
  diversos dies), mensual per dia o per enèsim dia de la setmana
  (`RelativeMonthlyRecurrence`), anual per dia o per enèsim dia de la
  setmana en el mes del venciment; sense fi, fins a una data o N vegades. Es
  llegeixen com a regla RRULE explicitada i s'escriuen amb `StartDate` = el
  venciment. Completar una ocurrència fa el mateix que a CalDAV: la
  tasca passa a l'ocurrència següent (`DueDate`, `Recurrence` amb el que
  queda, `StartDate`) i es crea una còpia completada sense regla. No es marca
  la sèrie com a completada al servidor, de manera que Exchange no genera
  ocurrències pel seu compte.
- **Només lectura:** una tasca amb una regla que aquí no s'escriu —les que
  es regeneren N dies després de completar-se, diversos dies de la setmana en
  una regla mensual, «qualsevol dia laborable», anual en un mes diferent del
  del venciment, o una regla sense venciment— es mostra i es pot
  suprimir, però no editar, amb l'avís d'ADR-0053. «Cada N anys» amb N > 1
  no existeix a EWS (vegeu més amunt).
- Moure una tasca entre una llista d'Exchange i una altra llista es rebutja,
  com amb CalDAV.

### Comú

- **SOAP escrit a mà** per a llistes i tasques (`exchange/soap.rs`): unes
  poques operacions (`FindItem`, `GetItem`, `CreateItem`, `UpdateItem`,
  `DeleteItem`) escrites com a text amb els prefixos `m:` i `t:`, i la
  resposta llegida amb `quick-xml` (ja era dependència directa) per nom
  local, com el lector WebDAV. Una fallada SOAP sencera falla; un error per
  element s'informa amb el seu codi.
- **Esquema 65** (el 64 és de #210, que entra abans):
  `contact_group_members.name` i `.addr`; `task_lists.ews_account`;
  `folder_renames`, `ews_folder_paths` i `ews_uncertain_moves`.

## Alternatives descartades

- **Moure carpetes d'Exchange sense canviar els noms (llista plana):** el
  moviment no es veuria i dues subcarpetes amb el mateix nom continuarien
  trepitjant-se; la jerarquia cal igualment.
- **Tornar a baixar les subcarpetes en lloc de portar la seva memòria cau a
  la ruta nova:** més simple, però torna a baixar tot el seu correu per un
  canvi de nom.
- **Desar els ids de carpeta d'Exchange a la base de dades** per a
  seguir qualsevol reanomenament fet en un altre client: és una taula nova
  per a un cas que la sincronització següent ja resol (com a IMAP).
- **Ampliar el crate `ews`** amb membres i camps de tasca: obliga a
  publicar una versió nova de la bifurcació; el SOAP escrit a mà és
  local, provat amb respostes enregistrades i sense dependències noves.
- **`ConflictResolution="AutoResolve"` o escriure la llista sencera de
  membres:** sobreescriuria la feina d'un altre client (ADR-0012).
- **Amagar els membres que no són contactes,** com fa ADR-0052 amb els
  `mailto:` de CardDAV: a Exchange són la majoria i les llistes es veurien
  buides.
- **Marcar la sèrie com a completada i deixar que Exchange generi
  l'ocurrència següent:** depèn d'un comportament del servidor que no
  es pot provar sense un de real; es fa igual que a CalDAV.
- **Crear tasques sense id propi i acceptar un duplicat si es perd la
  resposta:** contradiu ADR-0039.

## Pendent

- Evidència amb un servidor Exchange real (N5): que accepta
  `IsDeliveryReceiptRequested` al costat del MIME, els membres de tipus
  contacte escrits com es descriu, i la conversió de `DueDate` en bústies
  amb zona horària negativa.
- Les subcarpetes de Contactes i altres carpetes de contactes o de tasques
  de la bústia; bústies compartides més enllà de la principal del compte.
- Editar els contactes d'Exchange (ADR-0012 els continua deixant en només
  lectura).
- Afegir a una llista d'Exchange algú d'una altra llibreta (com a adreça
  solta).
- Les tasques i llistes d'Exchange al mòbil.
- Microsoft Graph: To Do i contactes de Graph (moure carpetes i
  confirmació de lliurament van arribar amb ADR-0057, #210).

## Proves

Totes amb respostes SOAP enregistrades, sense servidor real:

- `exchange/tests/folder_moves.rs`: rutes, `/` en un nom, cadena de
  pares en bucle, memòria cau del nom pla que segueix la seva carpeta (i un
  altre compte que no es toca), nom compartit, moviment (èxit, al nivell
  superior, servidor canviat des de la memòria cau, rebuig del servidor,
  resposta perduda sense repetició, carpetes especials).
- `exchange/tests/delivery_receipts.rs` i `main.rs`: la petició a
  l'element, res sense demanar-la, rebuig, resposta perduda; `requested` per
  a Exchange i `unsupported` per a Graph.
- `exchange/book/tests.rs` i `pim/exchange_book/tests.rs`: lectura de
  contactes i llistes, lectura que falla sencera, diferència enviada, còpia
  local obsoleta que no trepitja el servidor, conflicte del servidor, error i
  resposta perduda, crear i suprimir, dos comptes per separat.
- `exchange/tasks/tests.rs` i `task_sync/exchange/tests.rs`: camps, regles
  llegides i escrites, només el que ha canviat, edició, conflictes i la seva
  resolució, error, creació amb resposta perduda sense duplicat,
  ocurrència completada, supressió, dos comptes per separat.
- `folder_move.rs`: totes les columnes que anomenen una carpeta estan
  decidides; tasques, ajornades, registre, progrés d'arxivament, regles del
  compte i política confirmada segueixen el canvi de nom, i res d'un altre
  compte; els canvis de nom es llegeixen una vegada per compte.
- Frontend: `folderMoves.test.ts`, `folderMove.test.ts` (canvis de nom
  d'una llista de carpetes), `ExchangeGroups.test.tsx`,
  `ExchangeTaskLists.test.tsx`.
