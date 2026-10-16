# ADR-0057: Moure carpetes i demanar confirmació de lliurament a Graph; llegir els informes de lliurament i de lectura

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #210: «la opción más prudente»); pendent de revisió del
  propietari al final del pla.
- Data: 2026-10-15.
- Abast: #210, sobre les files SET-07 (#87, carpetes) i SET-11 (#107,
  confirmacions) del registre d'acceptació. Completa el que ADR-0050 i ADR-0048
  van deixar pendent per a Microsoft Graph i afegeix llegir els informes que
  arriben, en tots els tipus de compte. Exchange (EWS) en queda fora: és una
  altra incidència (#211), que pot reutilitzar `receipts::delivery_receipt`.

## Decisió

- **Moure una carpeta a Graph** (`folders.move`, la mateixa ordre que IMAP):
  - només en un compte el permís del qual es va desar amb canvis
    (`Mail.ReadWrite`, #141). Sense aquest permís, la protecció de només
    lectura l'atura abans de res i la interfície diu «Permet els canvis
    d'aquest compte als seus paràmetres per a moure'n les carpetes». No cal
    cap permís nou;
  - les carpetes de Graph no són rutes sinó ids opacs amb el seu pare, així que
    les regles d'ADR-0050 es comproven sobre l'arbre que Graph ha informat
    (`graph_folders`): mai una carpeta especial (Safata d'entrada,
    Enviats, Esborranys, Elements suprimits, Correu brossa, Arxiu),
    ni una que en tingui una a dins, ni una carpeta de cerca (ni cap a ella),
    ni dins d'ella mateixa o d'una subcarpeta, ni allà on ja és, ni al costat
    d'una altra amb el mateix nom (sense distingir majúscules, com Exchange).
    La interfície aplica les mateixes regles recorrent `parent_id`;
  - una sola petició, `POST /me/mailFolders/{id}/move` amb
    `{"destinationId": …}` (l'arrel de la bústia per al nivell superior), amb
    `Prefer: IdType="ImmutableId"`, sense redireccions i sense repetir-la mai.
    La resposta ha de dir el pare demanat. Un èxit d'una altra forma
    (un altre pare, cap, una resposta il·legible) o un 5xx no és ni
    confirmació ni rebuig: és **incert**. Només un rebuig del servidor
    (4xx) es diu «no s'ha mogut»;
  - després, tant si ha anat bé com si ha anat malament o és dubtós, es torna
    a llegir l'arbre de carpetes: la memòria cau diu on és la carpeta al
    servidor, no on es va intentar deixar;
  - **resultat incert**: es diu «no se sap si s'ha mogut; no s'ha
    repetit». L'arbre ja s'ha tornat a llegir al nucli i la interfície
    torna a demanar la llista, així que tornar-ho a demanar troba la carpeta
    al seu lloc: «ja hi és», dit com a informació i no com a error, sense
    segona petició;
  - amb ids immutables la carpeta conserva el seu id, i per tant el seu nom
    local: no hi ha reanomenaments i els missatges a la memòria cau s'hi
    queden. Si Graph retorna un altre id, s'informa d'aquest reanomenament
    perquè preferides, colors i vistes el segueixin.
- **Demanar confirmació de lliurament a Graph:**
  - Graph envia el MIME tal qual (`sendMail` en base64, #143), sense sobre
    on posar la petició. `isDeliveryReceiptRequested` és una propietat
    del missatge, que només es pot fixar sobre un esborrany. Així que, quan
    es demana, l'enviament va en tres passos: esborrany a partir del mateix
    MIME (`POST /me/messages`, `text/plain` en base64), `PATCH` amb
    `{"isDeliveryReceiptRequested": true}` i `POST /me/messages/{id}/send`;
  - **la política** és la d'ADR-0048, ara en una funció petita i
    compartida, `receipts::delivery_receipt(pedida, la_vía_la_lleva)`: es
    demana només si la persona la vol i la via la pot portar (SMTP amb
    DSN; Graph amb canvis a més d'enviament). Sense demanar-la, res no canvia;
  - **prudència fins a tenir evidència de Microsoft 365:** encara no se sap
    si un esborrany fet des de MIME conserva els destinataris Cco ni la
    signatura o el xifratge byte a byte. Perdre un Cco seria silenciós. Així
    que l'esborrany només es fa servir per a un missatge sense Cco i sense
    signatura ni xifratge. En els altres casos (o sense canvis permesos) el
    missatge surt com sempre per `sendMail`, sense la petició, i l'enviament
    respon `delivery_receipt: "unsupported"` amb `delivery_receipt_reason`
    (`needsChanges`, `bcc` o `protected`), que el redactor explica;
  - una fallada abans de l'últim pas (esborrany o marca) és «no enviat»
    (`NotSent`): no ha sortit res, se suprimeix l'esborrany i l'intent queda
    com a rebutjat, mai com a incert. Si l'esborrany no s'ha pogut suprimir, o
    la seva creació ha quedat sense resposta, es diu que pot quedar una còpia
    a Esborranys;
  - l'últim pas és un enviament com els altres (#143, contracte de #29): 202
    acceptat; sense resposta, 5xx, qualsevol altre 2xx o una resposta
    il·legible, **incert**, sense desfer ni repetir, dient que pot
    quedar una còpia a Esborranys; només un rebuig (4xx) suprimeix l'esborrany
    i deixa l'intent com a rebutjat. `sendMail` segueix la mateixa regla;
  - l'esborrany es pot veure a Esborranys des d'altres clients durant
    l'instant que triga l'enviament. Si l'aplicació es tanca entre crear
    l'esborrany i enviar-lo, l'esborrany hi queda i l'intent queda obert
    a `outgoing_attempts` (#29), que la persona resol;
  - la còpia d'Enviats la desa Microsoft, com amb `sendMail`.
- **Llegir els informes que arriben** (tots els tipus de compte):
  - l'analitzador MIME del nucli reconeix un `multipart/report` de primer
    nivell amb `report-type=delivery-status` (DSN, RFC 3464) o
    `disposition-notification` (MDN, RFC 8098), i en llegeix només la part
    per a màquines (`message/delivery-status`, `message/disposition-notification`
    i les seves variants `global` de RFC 6533), mai el text per a persones;
  - de cada destinatari: lliurat, reenviat sense més informes (`relayed`,
    `expanded`), endarrerit, fallit (amb el seu codi d'estat RFC 3463 i les
    paraules del servidor, limitades a 500 caràcters i sense caràcters de
    control), mostrat o tractat sense mostrar (`deleted`, `dispatched`,
    `processed`). El que no es reconeix (`denied`, `failed` de RFC 3798,
    accions inventades) no s'interpreta: un informe mal format es queda
    com un missatge normal;
  - **vincle:** per Message-ID. L'MDN el diu a `Original-Message-ID`; el
    DSN, a la còpia o a les capçaleres de l'original que retorna
    (`message/rfc822`, `text/rfc822-headers`, `message/global[-headers]`).
    Es desa per compte a `delivery_reports` (esquema 64) en desar el
    cos a la memòria cau, sigui quin sigui el protocol que l'ha portat, quan
    el compte té aquest missatge (a la seva memòria cau o a
    `outgoing_attempts`). Si encara no el té (la Safata d'entrada s'ha
    sincronitzat abans que Enviats, per exemple), l'informe espera a
    `delivery_reports_pending`, com a molt 90 dies i 1000 per compte (se'n van
    els més antics), i es vincula tan aviat com el missatge apareix i es
    mostra; mentrestant, l'informe es veu com un missatge normal. Una paraula
    final substitueix un retard i mai al revés; si no, guanya l'informe més
    recent, amb la data limitada pel moment en què es llegeix (una data
    futura no pot guanyar). Un informe a Enviats o Esborranys (una
    confirmació que ha enviat aquest compte) no compta com a rebut;
  - **quan es vincula:** quan es llegeix el cos de l'informe. A Graph,
    en sincronitzar una carpeta es recorre la llista d'informes per classe
    d'element, pàgina a pàgina (fins a 10 pàgines per sincronització),
    saltant els ja llegits, i es llegeix el MIME de fins a 20 de nous, també
    els desats abans d'aquesta versió; cadascun es llegeix una sola vegada. Un
    que no es pot llegir per si mateix (massa gran, ja no hi és, il·legible)
    es marca amb el motiu i es passa al següent; una fallada del servidor o
    del compte (límit, connexió, inici de sessió) atura el recorregut
    fins a la sincronització següent, que torna a començar. A IMAP i
    EWS depèn que el cos es baixi (precàrrega o en obrir-lo); un
    informe desat a la memòria cau abans d'aquesta versió no es torna a llegir;
  - **on es veu, i com:** un informe és una afirmació de qui l'envia, i es
    diu així: «L'informe diu que s'ha lliurat a…», «El programa de correu
    de … diu que s'ha mostrat», amb la seva data, «a data de …» per a un
    retard, les fallades primer, i marcat quan anomena algú a qui el
    missatge no anava dirigit. El motiu d'una fallada es dona amb una frase
    per als codis RFC 3463 comuns (x.1.1/x.1.10 l'adreça no existeix,
    x.2.2 bústia plena, x.7.x rebutjat per la política del servidor, 4.x.x
    problema temporal) i les paraules del servidor a part, sense repetir el
    codi; adreces i motius van aïllats (bidi) i sense caràcters de
    format (Cf), perquè un text de dreta a esquerra no reordeni la
    frase. En el mateix informe es veu el que diu, amb el títol «Informe de
    lliurament» o «Informe de lectura», i «sobre un missatge que vas enviar»
    només si coincideix amb un d'aquest compte. No s'envia ni es respon res
    per llegir-los;
  - a Graph, un missatge sense adjunts es llegeix del seu JSON, que en un
    informe només porta el text per a persones. En llegir un missatge també
    se'n demana la classe (`$expand` de la propietat estesa `String 0x001A`);
    si és `REPORT.*`, se'n llegeix el MIME. N'hi ha prou amb `Mail.Read`.
- **Privadesa:** no canvia el que surt de l'equip. L'esborrany viu uns
  instants a la mateixa bústia de Microsoft, que ja rebia el missatge; llegir
  la classe del missatge i els informes no envia res. `docs/privacy.html` no
  canvia.

## Alternatives descartades

- **Enviar en JSON (`sendMail` amb l'objecte `message`) quan es demana la
  confirmació:** perdria la signatura i el xifratge, les imatges en línia i
  tot el que el MIME ja construeix igual per a SMTP, EWS i Graph.
- **Capçalera `Return-Receipt-To` al MIME:** no és un estàndard i no hi ha
  manera de saber si Exchange la respecta (ja descartada a ADR-0048).
- **Repetir automàticament un moviment o un enviament incerts:** pot
  duplicar; en lloc d'això es llegeix l'estat del servidor.
- **Moure carpetes a Graph com a IMAP, reanomenant rutes:** les seves carpetes
  no són rutes; l'id i el pare són la veritat.
- **Interpretar informes per l'assumpte o el text («Undeliverable:…»):**
  depèn de l'idioma i del servidor i es pot falsificar sense esforç; només
  es llegeix la part per a màquines.
- **Demanar el MIME de tots els missatges de Graph per a trobar informes:**
  una baixada per missatge obert; n'hi ha prou amb la classe de l'element per
  a saber quins ho són.
- **Amagar o arxivar els informes vinculats:** la persona decideix què
  fa amb el seu correu; l'informe es queda on ha arribat.

## Pendent

- **Evidència amb Microsoft 365 real** (l'execució N5 final): que
  `/mailFolders/{id}/move` conserva l'id amb `ImmutableId`; que un esborrany
  creat des de MIME conserva Message-ID, `Bcc`, signatura i xifratge en marcar-lo
  i enviar-lo; que el MIME d'un `REPORT.IPM.Note.IPNRN` o `.NDR` arriba com a
  `multipart/report`.
- Exchange (EWS): moure carpetes i demanar confirmació de lliurament (#211).
- Un informe rebut en un compte diferent del que va enviar el missatge no es
  vincula (aïllament entre comptes).
- Un informe és una afirmació de qui l'envia: es mostra com el que
  diu, sense comprovar que el destinatari fos un dels del missatge.
- La lectura d'un sol missatge per id d'UID (`messages.read`, fora d'un
  fil) encara no porta els informes, igual que `receipt_requested`.
- La versió d'esquema 64 pot topar amb altres branques obertes alhora;
  si una altra branca es fusiona abans, aquesta en renumera la migració.
- Un informe que espera més de 90 dies el seu missatge, o que queda fora dels
  1000 que esperen per compte, es perd; l'informe continua a la bústia.
- Confirmació de lliurament a Graph per a missatges amb Cco o signats o
  xifrats, quan l'evidència N5 mostri que l'esborrany els conserva
  (comprovant també els destinataris de l'esborrany abans d'enviar-lo).
