# ADR-0055: Presència, mencions, avisos i missatges privats al xat (XMPP)

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  #208: «la opción más prudente»); pendent de revisió del propietari al
  final del pla.
- Data: 2026-10-15.
- Abast: #208, filla de #111 (fila SET-21 del registre d'acceptació, «Xat →
  General» d'eM Client 10.4). Completa el que ADR-0036 i ADR-0044 van deixar
  pendent: la presència i l'estat propis, la presència dels contactes,
  les mencions als grups, les notificacions del sistema i els missatges
  privats dins d'un grup. L'esborrany #198 es va fer servir com a referència
  i es va revisar punt per punt; les diferències són a «Alternatives
  descartades».

## Decisió

- **L'estat propi, per compte:**
  - «Disponible», «Absent», «Ocupat» (`dnd`) i «Invisible», i un text
    d'estat de fins a 200 caràcters (sense caràcters de control);
  - es desa com una fila de paràmetres (`chat_presence:<cuenta>`, JSON), sense
    taules ni columnes noves; un camp no vàlid torna al seu valor per defecte
    («Disponible», sense text) sense tocar l'altre. En treure el compte se suprimeix;
  - s'anuncia en connectar i cada vegada que la persona el canvia; la
    visualització mostra sempre el desat, també abans de connectar, i la sessió
    comença des d'aquest (mai des de «Disponible» per defecte).
- **A qui arriba:**
  - l'estat s'anuncia sense destinatari, així que el servidor només el dona als
    contactes als quals la persona ha permès veure'l (subscripció, RFC 6121);
  - als grups on és només hi arriba la disponibilitat
    (absent, ocupat), **mai el text**: en un grup hi ha gent que la
    persona no ha triat;
  - la persona no rep res de nou de ningú: la presència dels altres l'envia
    el seu servidor.
- **Invisible, només on el servidor ho admet** (XEP-0186):
  - a cada connexió es pregunta al servidor del compte què admet
    (disco#info); si anuncia `urn:xmpp:invisible:0`, «Invisible» es pot
    triar; si no, apareix desactivat amb el motiu i el nucli el rebutja;
  - invisible, la persona continua rebent missatges en directe i els seus
    contactes la veuen desconnectada. Els grups on ja és la continuen
    veient (entrar en un grup és presència dirigida); la visualització ho diu;
  - sense connexió no se sap què admet: «Invisible» espera a connectar i la
    visualització ho diu («Connecta't per a comprovar si aquest servidor et pot
    amagar»);
  - si un «Invisible» desat es troba amb un servidor que ja no l'admet,
    **no s'anuncia res** (la persona continua amagada, com va demanar): els seus
    contactes la veuen desconnectada i els missatges directes i les peticions
    per a veure el seu estat esperen al servidor fins que triï un altre estat;
    en triar-lo s'anuncia i es recupera el que ha arribat a l'arxiu. Mai no
    passa tota sola a visible;
  - si ja estava anunciada, passar a no anunciada envia «no disponible» a
    tothom, i el servidor la treu també dels grups (RFC 6121 §4.6); per
    això s'hi torna a entrar de seguida: els grups la continuen veient,
    disponible, com diu la visualització.
- **La presència dels contactes:**
  - arriba del servidor i es desa només en memòria, per a la sessió: una
    sessió nova comença de zero. No va al magatzem, perquè en tornar seria
    antiga;
  - un contacte vist que es desconnecta, o del qual el servidor diu que és
    desconnectat (ho diu dels que la persona pot veure), queda com a
    «Desconnectat» per a la sessió, sense tornar a oferir «Demanar veure el
    seu estat»;
  - com que qualsevol pot enviar presència, es desen com a màxim 1000
    contactes, 50 dispositius per contacte i 200 peticions; el que passa
    d'aquí es descarta. Una presència amb la marca de grup (`muc#user`) mai no
    és d'un contacte;
  - d'un contacte amb diversos dispositius es mostra el de prioritat més
    alta i, a igualtat, el més disponible (xerrant, disponible, absent,
    absent molt de temps, ocupat);
  - es mostra al costat de cada conversa directa i a la seva capçalera, amb el
    seu text d'estat.
- **Veure l'estat d'un altre és decisió de la persona:**
  - «Demanar veure el seu estat» envia la petició (`subscribe`) només en prémer;
  - les peticions d'altres es mostren com a proposta, amb «Permetre»
    (`subscribed`) i «Rebutjar» (`unsubscribed`); res no es contesta tot sol i
    permetre no demana el mateix de tornada. «Permetre» només respon a qui ho
    ha demanat en aquesta sessió; «Rebutjar» val per a qualsevol;
  - les peticions pendents es desen només en memòria: el servidor les
    torna a lliurar a cada connexió.
- **Mencions en un grup:**
  - un missatge d'un altre menciona la persona si el seu text conté el seu
    sobrenom en aquell grup com a paraula sencera (sense distingir majúscules;
    lletres, xifres i `_` de qualsevol alfabet formen paraula), o si porta una
    referència XEP-0372 a la seva adreça o al seu lloc al grup (`grupo/apodo`).
    Un sobrenom de menys de tres caràcters només menciona després de `@` («al»,
    «Jo» també són paraules corrents). El que és propi mai no menciona;
  - en escriure `@` i el principi d'un sobrenom, l'editor ofereix els que
    són al grup ara (sense la persona), filtrats per aquest principi, com a
    molt 8; fletxes, Retorn o Tab per a triar i Escapada per a tancar. El que
    s'ha triat s'escriu com a `@apodo `;
  - els sobrenoms triats surten a més com a referències XEP-0372 (`begin` i
    `end` en caràcters), només si continuen al text en enviar. El que s'ha
    triat no es desa: «Tornar a enviar» envia com a referències els sobrenoms
    escrits amb `@` dels qui són al grup en aquell moment;
  - qui és a cada grup surt de la presència del grup, en memòria; un
    sobrenom que el grup ens canvia (estat 210) es desa tal com el dona el
    grup, encara que no sigui un que acceptaríem en unir-nos-hi, perquè les
    mencions i l'eco continuïn funcionant;
  - el ressaltat es calcula en llegir l'historial amb el sobrenom actual,
    sense columna nova. Una menció feta només per referència, sense el sobrenom
    al text, avisa en arribar però no queda ressaltada després.
- **Notificacions del sistema:**
  - decideix el nucli, que sap com ha arribat cada missatge (funció pura
    `should_notify`): només un missatge desat per primera vegada, d'una altra
    persona i arribat en directe, o com a còpia d'un de rebut en un altre
    dispositiu (carbons `received`: arriba en directe i és nou aquí). El
    que arriba en posar-se al dia (arxiu, historial del grup, missatges amb
    retard) no avisa: es veu com a no llegit;
  - missatges directes i privats: sempre; en un grup, només les mencions;
  - mai mentre l'estat propi d'aquell compte és «Ocupat», i la visualització
    ho diu sota el selector;
  - el nucli emet `chat.notify` (compte, conversa, tipus, grup, qui
    i el text, o el nom del fitxer, retallat a 280 caràcters; el títol,
    a 120); el pont
    Go mostra la notificació llevat que hi hagi «No molestar» o hores de silenci
    (ADR-0049): un missatge de xat compta com un missatge, igual que el
    correu, i no com un recordatori;
  - el títol és qui escriu i, en un grup o en privat, `· grupo`, sense
    textos nous per a traduir a Go; en prémer-la s'obre aquella conversa
    a la visualització Xat;
  - el que ha escrit un altre es mostra com a text: a Linux el cos s'escapa
    per al servei de notificacions que llegeix marques (`body-markup`) i, a
    Windows, títol, cos i destinació es protegeixen per a la plantilla XML de
    la notificació, que els insereix tal com són (això últim també arregla
    el correu, la destinació del qual pot portar `<` i `>` d'un Message-ID).
- **Missatges privats dins d'un grup** (XEP-0045 §7.5):
  - són una conversa pròpia, `grupo@servicio/apodo` (tipus `private`),
    llistada amb les directes com a «sobrenom (grup)»; el sobrenom conserva
    les seves majúscules;
  - s'obren des del sobrenom de qui parla al grup o des de la llista de
    qui hi és; surten com a `chat` a `grupo/apodo`, amb `origin-id`, la marca
    `muc#user` i sense demanar confirmació de lliurament (el reparteix el grup);
  - només es reconeixen com a privats els d'un grup on és la
    persona; un del grup sense sobrenom no és una conversa; un error retornat
    per a un dels nostres el deixa en «no enviat», com sempre;
  - en sortir del grup, els seus privats **es queden** per a llegir-los:
    l'arxiu del grup no els desa, així que suprimir-los els perdria. Tornar-hi
    a escriure necessita tornar a ser al grup (sense això no hi ha sobrenom
    amb què escriure i el nucli ho rebutja).

## Alternatives descartades

- **Taules i columnes noves (esquema 63/64, com a #198):** altres tasques
  afegeixen migracions alhora i els números xocarien; l'estat cap en una
  fila de paràmetres i la menció es calcula en llegir. Per això una menció feta
  només per referència avisa en arribar però no queda ressaltada després.
- **Suprimir els privats en sortir del grup:** es perdrien sense remei, sense
  que la persona ho hagi demanat.
- **Llegir la llista de contactes del servidor (roster) per a saber qui es
  pot veure:** necessita contestar als seus avisos de canvis; amb recordar el que
  s'ha vist a la sessió, i el que el servidor diu dels contactes desconnectats,
  n'hi ha prou per a no oferir demanar-ho una altra vegada. Gestionar qui veu
  l'estat queda pendent.
- **Invisible enviant «no disponible» i consultant l'arxiu sovint
  (#198):** la persona deixaria de rebre en directe i sortiria dels
  grups; XEP-0186 és la manera estàndard i, sense això, es diu que no es pot.
- **Absent automàticament per inactivitat (#198):** necessita saber la
  inactivitat del sistema a cada plataforma des de Go; queda pendent.
- **Modes d'avís per conversa (tot, mencions, silenci, #198):** no
  els demana #208; el silenci general ja el donen «No molestar» i les hores
  de silenci.
- **Enviar el text d'estat també als grups:** el veurien persones
  que la persona no ha triat.
- **Decidir les notificacions a la visualització:** la visualització no sap
  si un missatge ha arribat en directe o de l'arxiu, i amb la finestra a la
  safata els seus temporitzadors es retarden (ADR-0049).
- **Avisar també del que s'ha recuperat en connectar:** en obrir l'aplicació
  després de dies tancada sortiria una notificació per cada missatge antic.
- **Demanar confirmació de lliurament als privats:** el grup els reparteix i
  la confirmació de l'altre revelaria a algú que no és entre els seus
  contactes quan llegeix.

## Pendent (#111 continua oberta)

Nota (2026-10-17, #256): l'ADR-0064 resol la gestió de qui pot veure l'estat
propi (llegint el roster, que l'alternativa descartada de més amunt deixava per
a després), el silenci d'una conversa i el comptador de mencions sense llegir;
l'absència per inactivitat és la proposta de l'ADR-0065, pendent de decisió.

- Absent per inactivitat i silenciar una conversa concreta.
- Gestionar qui pot veure l'estat propi (retirar un permís donat).
- Un comptador de mencions sense llegir.
- Provar «Invisible» contra un servidor amb XEP-0186 (el Prosody de CI no el
  porta) i la notificació nativa a Windows (N4).
- Rocket.Chat; Teams i Slack quan existeixin els registres.
