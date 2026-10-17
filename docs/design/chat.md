# Xat (#110, #111)

Registre de la implementació de l'ADR-0036, l'ADR-0044 (grups i fitxers),
l'ADR-0055 (presència, mencions, avisos i privats en grups, #208) i l'ADR-0064
(qui pot veure l'estat, silenciar una conversa i mencions sense llegir, #256).
L'absència automàtica per inactivitat és la proposta de l'ADR-0065, sense codi.

## Peces

- **Nucli:**
  - `meron-core/src/chat/`: el magatzem (`chat_accounts`, `chat_messages`,
    `chat_reads`, esquema 54, amb una columna pròpia `chat_account`) i
    `xmpp.rs`, amb el connector sobre `crate::tls`, la interpretació de
    stanzas i la sessió (arxiu per pàgines, carbons, rebuts i ack);
  - RPC `chat.accounts/status/save/remove/conversations/history/markRead/send/retry`;
  - esdeveniments `chat.changed` i `chat.status`;
  - els comptes es connecten en arrencar.
- **Grups i fitxers (ADR-0044, esquema 58):**
  - taules `chat_rooms` i `chat_invitations`; a `chat_messages`, `kind`
    (`chat` o `groupchat`) i el fitxer (`file_url`, `file_name`,
    `file_size`);
  - `chat/xmpp.rs`: entrada a sales amb historial, eco propi sense duplicar,
    arxiu de la sala, invitacions i la pujada (cerca del servei, espai, `PUT`
    i missatge amb OOB);
  - `chat/files.rs`: només HTTPS, nom segur, límit del servei, pujada amb
    progrés i cancel·lació, i baixada a petició;
  - RPC `chat.rooms/join/leave/invitations/dismissInvitation`,
    `chat.sendFile/cancelUpload/download`; a Go, `chat.pickFile` i
    `chat.saveFileAs` (diàlegs del sistema);
  - esdeveniments `chat.room`, `chat.invitation`, `chat.progress` i
    `chat.uploaded`; la contrasenya d'una invitació es queda al nucli
    (clauer) i no arriba a la vista.
- **Presència, mencions, avisos i privats (ADR-0055, sense esquema nou):**
  - `chat/presence.rs`: l'estat propi a la fila de configuració
    `chat_presence:<compte>`; `plan` decideix anunciar, amagar (XEP-0186) o
    no anunciar res; els contactes (el millor dispositiu), les peticions i qui
    hi ha a cada grup, a `Live`, compartit amb l'aplicació i només en memòria;
    `should_notify` i l'esdeveniment d'avís;
  - `chat/mentions.rs`: el sobrenom com a paraula sencera o una referència
    XEP-0372 a nosaltres; les referències dels sobrenoms triats en enviar;
  - `chat/xmpp.rs`: disco#info del servidor a cada connexió, l'estat en
    connectar i en canviar-lo (als grups, només la disponibilitat), les
    peticions, qui entra i surt de cada grup, el sobrenom que el grup ens
    assigna (210), els privats (`grup/sobrenom`, tipus `private`) i l'avís del
    que arriba en directe;
  - RPC `chat.presence/setPresence/subscribe/answerSubscription/occupants`;
    `chat.send` accepta `mentions`; esdeveniments `chat.own`, `chat.presence`,
    `chat.subscription`, `chat.occupants` i `chat.notify`;
  - a Go, `chat.notify` surt com a notificació del sistema excepte amb «No
    molestis» o hores de silenci (com el correu); en prémer-la
    (`chat:<conversa>`) s'obre a la vista «Xat».
- **Qui pot veure l'estat, silenci i mencions (ADR-0064, sense esquema nou):**
  - `chat/presence.rs`: `roster_query` a cada sessió nova, `roster_push` (només
    del servidor propi) i la seva resposta, i a `Live` la llista `allowed`
    (`null` fins que el servidor respon, com a màxim 5000, `allowed_more`);
  - `chat/mute.rs`: la fila `chat_mute:<compte>` (com a màxim 1000 converses),
    oblidada en treure el compte i, per a un grup, en sortir-ne;
    `should_notify` rep `muted`;
  - `chat/mod.rs`: `muted` a les converses i als grups, i `unread_mentions` i
    `mentions_capped` als grups (com a màxim els 2000 missatges sense llegir
    més nous);
  - RPC `chat.mute` i `chat.muted`; `chat.presence` porta `allowed` i
    `allowed_more`; deixar de compartir és `chat.answerSubscription` amb
    `allow: false` (qualsevol adreça nua vàlida); esdeveniment
    `chat.permissions`; les comprovacions internes de si una sala existeix fan
    servir `room_nick` (sense recalcular mencions).
- **Aplicació:** la vista «Xat» a la barra lateral (configuració, converses
  amb no llegits, historial amb l'estat de cada enviament i «Torna a enviar»).
  Amb l'ADR-0044: «Uneix-te a un grup», els grups damunt de les converses
  directes, el sobrenom de qui parla, l'estat de la sala, «Surt del grup» amb
  confirmació, les invitacions com a proposta, el clip per enviar un fitxer
  amb el progrés i «Cancel·la», i els fitxers rebuts amb el nom i «Desa…».
  Amb l'ADR-0055: «El teu estat» i el seu text («Invisible» desactivat si el
  servidor no ho admet), les peticions amb «Permet» i «Rebutja», l'estat de
  cada contacte a la llista i a la capçalera o «Demana veure el seu estat»,
  en un grup «Persones del grup» amb «Escriu en privat», el sobrenom de qui
  parla per escriure-li en privat, els suggeriments en escriure `@` (llista
  accessible: fletxes, Retorn o Tab, Escapada) i «Et menciona» ressaltat; els
  privats com a «sobrenom (grup)» (`lib/chatMentions.ts` decideix el
  suggeriment). Amb l'ADR-0064: «Qui pot veure el teu estat» (desconegut fins
  que el servidor ho diu) amb «Deixa de compartir» i confirmació, el botó de la
  campana a la capçalera de cada conversa per silenciar-la, la campana barrada
  a la llista, i les mencions sense llegir de cada grup i el total del compte
  («@N», o «@N+» quan és un mínim).

## Proves

- **Magatzem:**
  - un missatge una sola vegada per id o per id d'arxiu;
  - els estats només avancen, i un de perdut queda incert sense reenviar-se;
  - l'arxiu el dona per acceptat;
  - no llegits i lectura que no retrocedeix;
  - aïllament entre comptes i supressió.
- **Stanzas:**
  - missatge entrant i propi des d'un altre dispositiu;
  - un id d'arxiu falsificat per un altre servidor s'ignora;
  - grup, error i buits no compten;
  - el que s'envia porta `origin-id` i demana rebut.
- **Grups i invitacions (ADR-0044):**
  - l'entrada demana historial (des de l'últim missatge o els 50 últims) i
    porta la contrasenya;
  - el sobrenom de qui parla, i només compta l'`stanza-id` de la sala;
  - la sala sense sobrenom, una altra sala i el canvi de tema no són missatges;
    la lectura directa no agafa missatges de grup;
  - el que s'envia a una sala és `groupchat` amb `origin-id` i sense demanar
    rebut;
  - l'eco propi, també des de l'arxiu amb un altre sobrenom, es desa una vegada
    i queda acceptat; un grup no és una conversa directa ni el seu arxiu és el
    del compte;
  - llista de sales amb no llegits; sortir esborra el que hi ha aquí; treure el
    compte esborra sales i invitacions; el pas de l'esquema es pot repetir;
  - invitació directa (amb contrasenya) i a través de la sala; no es desa per a
    una sala on ja s'és ni més de 20;
  - el que diu la sala de la nostra entrada (a dins, sala nova, error de
    contrasenya).
- **Fitxers (ADR-0044):**
  - servei de pujada i el seu límit a partir de disco#info; un fitxer més gran
    es rebutja abans de pujar-lo;
  - petició i resposta de l'espai; un espai per HTTP no es fa servir;
  - l'enllaç surt al cos i com a OOB i torna com a fitxer amb el nom
    descodificat; un nom no surt de la seva carpeta;
  - només HTTPS en pujar i en desar (http, ftp, file i credencials a l'enllaç,
    rebutjats), sense escriure res.
- **Presència, mencions, avisos i privats (ADR-0055):**
  - l'estat propi per compte: text net i de 200 caràcters com a màxim, un camp
    malmès torna només al seu valor, s'oblida en treure el compte;
  - l'estat desat es comunica abans de connectar i la sessió en parteix;
  - invisible només si el servidor ho anuncia; sense això, no s'anuncia res i
    mai no es passa sol a visible; passar d'anunciat a no anunciat torna a
    entrar als grups;
  - als contactes, disponibilitat i text; als grups, sense text;
  - l'estat d'un contacte és el del seu millor dispositiu i, desconnectat,
    continua sent conegut; una presència de grup no és d'un contacte; els
    contactes, els dispositius i les peticions tenen límit; «Permet» només a
    qui ho ha demanat; una sessió nova comença de zero;
  - qui hi ha en un grup (arriba, canvia de sobrenom, se'n va) i el sobrenom
    que ens assigna el grup, desat tal qual;
  - una menció: paraula sencera, sense distingir majúscules, en qualsevol
    alfabet, no dins d'una altra paraula (un sobrenom curt, només després
    d'`@`), o per referència; les referències que surten, una per cada
    sobrenom que continua al text, comptades en caràcters; en tornar a enviar,
    les dels `@sobrenom` escrits;
  - en llegir un grup només es marca el que anomena la persona;
  - avisa només del que és nou, d'un altre i en directe: no del que és
    repetit, endarrerit, de l'arxiu o propi, ni d'un grup sense menció, ni de
    res amb «Ocupat»;
  - un privat és una conversa pròpia (llista, no llegits, eco des d'un altre
    dispositiu, error retornat, majúscules del sobrenom), no demana rebut i el
    seu id d'arxiu compta per posar-se al dia; sortir d'un grup esborra el que
    és del grup i en deixa els privats per llegir-los.
- **Qui pot veure l'estat, silenci i mencions (ADR-0064):**
  - el roster: només `from` i `both`; desconegut abans de la resposta, i un
    avís sol no el fa conegut; els avisos del servidor propi (sense adreça o
    amb l'adreça nua) el canvien i es contesten amb un resultat buit; els d'un
    altre dispositiu, d'un altre, una pregunta o una altra càrrega no compten;
    el límit i `allowed_more`; una sessió nova el torna desconegut;
  - silenciada, cap avís (tampoc de menció) d'una conversa directa, privada o
    d'un grup, però desat i no llegit; per compte i amb majúscules del
    sobrenom; tornar a activar-los; sortir del grup n'oblida el silenci i no el
    dels privats; l'última treta no deixa fila; només converses, com a màxim
    1000 (la següent es rebutja); una fila malmesa; treure el compte;
  - les mencions sense llegir: la mateixa regla que el ressaltat, la lectura
    les descompta, el sobrenom actual, un altre compte a la mateixa sala (amb
    les seves mencions i la seva lectura), i el límit de 2000 com a mínim.
- **Pont Go:** la notificació del xat porta la conversa com a destinació i
  calla amb «No molestis» o hores de silenci encara que els recordatoris
  passin; un esdeveniment sense compte o sense conversa no avisa; el cos d'un
  missatge de xat és text per al servei que llegeix marques, i els textos i la
  destinació van protegits a la plantilla XML de Windows.
- **Clauer:** les contrasenyes de sales i invitacions són a `secret_names` i el
  comptador d'escriptures de secrets puja a 13.
- **Prosody real** (`tests/prosody-xmpp.sh`, també a la CI):
  - lliurament en directe amb rebut;
  - amb el destinatari desconnectat, el missatge arriba des de l'arxiu una
    sola vegada, també després de tornar a connectar una altra vegada;
  - dues persones en una sala nova: cadascuna sent l'altra amb el seu
    sobrenom, l'eco propi queda acceptat una vegada amb l'id de la sala, i qui
    torna entra sol una altra vegada i rep el que s'ha dit mentrestant una
    sola vegada, dues vegades seguides; sortir deixa la sala;
  - un fitxer de 300 kB per `mod_http_file_share` sobre HTTPS (autoritat de
    proves creada per l'script, `ORENETA_PROSODY_CA`): progrés, enllaç rebut
    amb el nom i desat idèntic; un de més d'1 MiB es rebutja abans de pujar-lo;
    un de cancel·lat no surt;
  - (ADR-0055, usuaris `eva` i `joan` només per a això) l'Eva demana veure
    l'estat d'en Joan i no arriba res fins que en Joan ho permet; després veu
    «Absent» amb el text `Comiendo` i «Ocupat»; en Joan no veu el de l'Eva;
    tots dos en un grup, en Joan hi continua mentre no s'anuncia i després;
    ocupat, un missatge es desa sense avís i, disponible, avisa; Prosody no
    ofereix invisible: en Joan «invisible» queda sense anunciar (l'Eva el veu
    desconnectat), i el que s'escriu mentrestant arriba una vegada en tornar i
    sense avís;
  - en un grup, cadascú sap qui hi ha; la menció arriba marcada i avisa, la
    resta no; un privat a `grup/Ana` arriba a l'Ana com a «Pau» a part del
    grup i amb avís, la resposta arriba a en Pau i queda acceptada; en sortir,
    el privat es queda.
- **Aplicació:**
  - llista amb no llegits, estats visibles;
  - «Torna a enviar» només en prémer, amb el mateix id;
  - enviament amb Retorn;
  - lectura en arribar a la conversa oberta;
  - alta d'un compte;
  - unir-se a un grup amb sobrenom i contrasenya, i obrir-lo;
  - en un grup, el sobrenom de cadascú, el seu estat, escriure-hi i sortir amb
    confirmació;
  - una invitació s'ofereix i només s'hi entra en prémer; «Ara no»;
  - enviar un fitxer amb progrés, cancel·lar, i l'avís de massa gran;
  - un fitxer rebut amb el nom i «Desa…», sense baixar-se sol; un per http no
    s'ofereix per desar;
  - (ADR-0055) l'estat i el seu text; «Invisible» desactivat o amb la seva
    explicació; l'avís de «no s'anuncia res»; demanar veure un estat,
    permetre i rebutjar, només en prémer; l'estat del contacte, i res sense
    connexió; en un grup, els suggeriments d'`@` (sense la persona, fletxes,
    Retorn, Escapada, no després d'una adreça), les mencions enviades, «Et
    menciona» només on correspon i qui hi ha; un privat llistat i obert, amb
    el sobrenom en majúscules, i obert des d'un nom del grup; prémer una
    notificació n'obre la conversa a «Xat»;
  - (ADR-0064) qui pot veure l'estat: desconegut, la llista que arriba amb
    `chat.permissions` (no la d'un altre compte), deixar de compartir només
    després de confirmar (cancel·lar no envia res), «S'està deixant de
    compartir…» fins que el servidor torna a dir la llista, l'error, «ningú»,
    «només els primers», una sessió nova, i res sense connexió; silenciar i
    tornar a activar des de la capçalera (directa, sense missatges encara,
    privada i grup), amb l'explicació per als lectors de pantalla, la llista ho
    diu i continua no llegida, la llista d'un altre compte no compta, i
    l'error; les mencions de cada grup, el total, el mínim (també
    zero) i res quan no n'hi ha.
- **Trobat en provar:** l'auditoria axe va detectar un element que no era `li`
  dins de la llista de missatges; corregit. Amb l'ADR-0044, el nucli acceptava
  còpies de carbons i resultats d'arxiu de qualsevol remitent; ara només del
  servidor propi (o d'una sala on s'és, per al seu arxiu).
