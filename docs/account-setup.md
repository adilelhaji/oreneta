# Assistent de configuració de comptes

La incidència #79 adopta d'eM Client la configuració guiada que comença per l'adreça de
correu electrònic i l'alternativa manual explícita, però no n'adopta l'aspecte visual,
els registres d'autenticació ni les afirmacions sobre proveïdors.
[Referència](https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Accounts/Create%20New%20Account.htm).

La primera execució i l'acció d'afegir un compte comparteixen dos passos: primer l'adreça
de correu electrònic i després la connexió. Els dominis públics exactes de
Google/Microsoft suggereixen el flux OAuth existent; els altres dominis fan servir la
detecció IMAP/SMTP existent. No es dona per fet que els dominis corporatius
personalitzats facin servir cap dels dos proveïdors: les dreceres explícites de
Google/Microsoft i l'Exchange manual continuen disponibles. L'autorització del proveïdor
determina l'adreça final del compte OAuth.

La configuració manual manté IMAP/SMTP, Exchange i RSS. Tornar enrere conserva l'adreça;
iniciar una altra connexió esborra les credencials i els paràmetres del servidor. La
detecció no ha de sobreescriure les modificacions de l'usuari ni emplenar una adreça
diferent. Els paràmetres detectats o endevinats no són prova d'autenticació. Abans de
desar un compte IMAP/POP3 manual, l'aplicació en fa la prova de connexió (vegeu més
avall); els errors conserven el formulari perquè es pugui corregir. La disponibilitat
d'OAuth i l'espera al navegador s'expliquen, en lloc de representar-se amb botons
desactivats sense explicació.

La incidència #79 no va canviar cap contracte de transport Go/Rust, d'àmbit OAuth, de
clauer, de confiança en certificats ni d'edició/reconnexió; #269 hi afegeix
`account.testConnection` i «Desa igualment» (vegeu més avall). No s'afegeix cap servei
de xarxa nou de detecció. Es proporcionen els textos en anglès i en castellà; els altres catàlegs fan servir l'anglès
per a les claus noves fins que es tradueixin.
La validació de les adreces noves no rebutja retroactivament les identitats de comptes
existents; editar els paràmetres del servidor amb la contrasenya en blanc conserva la
credencial desada.

Verificació: les proves pures d'adreça/proveïdor i les proves de navegador sobre
l'entrada de producció amb respostes sintètiques explícites de Wails cobreixen la
validació, les opcions de proveïdor, la detecció manual, el desament fallit/correcte, la
navegació enrere i la reutilització del diàleg modal.
La prova de fum nativa de la primera execució identifica el camp de l'adreça de correu
electrònic i les dues opcions de proveïdor.
Tornar enrere o tancar invalida les crides de retorn (callbacks) OAuth pendents del
frontend; no revoca cap concessió al proveïdor. No es desa cap compte a partir d'una
crida de retorn descartada. Un intent nou continua fent servir la validació existent de
Begin/state del backend.
L'autorització amb proveïdors reals i la interoperabilitat amb servidors no són una
prova simulada de credencials que funcionin.


## Prova de connexió i correcció (#269)

Abans d'aquesta incidència, desar era l'única comprovació de la connexió: l'IMAP o el POP3
iniciava la sessió, però del servidor SMTP només se'n comprovava el certificat, i un error
no deia quin pas havia fallat. Ara la configuració manual IMAP/POP3/SMTP té l'acció
«Prova la connexió», i «Desa el compte» fa la prova primer.

- La prova (`account.testConnection` del nucli, `meron-core/src/connection_test.rs`)
  comprova el servidor d'entrada (IMAP o POP3) i el de sortida (SMTP) alhora i per
  separat, pas a pas: resolució del nom (DNS), connexió TCP, xifratge (TLS des del
  començament o STARTTLS) i inici de sessió. Cada pas es mostra com a correcte, error, no
  aplicable (sense xifratge triat, servidor intermediari que resol el nom, servidor SMTP
  que no demana iniciar la sessió) o sense provar. La prova SMTP inicia la sessió i surt:
  no indica cap remitent ni cap destinatari.
- Cada error diu què cal corregir, i la interfície n'ofereix la correcció probable: els
  parells de port i seguretat habituals del protocol (993/TLS i 143/STARTTLS, 995/TLS i
  110/STARTTLS, 465/TLS i 587/STARTTLS; primer el mateix port amb l'altra seguretat quan
  és l'error probable), l'altra forma del nom d'usuari (l'adreça sencera o la part abans
  de l'@) o la inspecció del certificat. No s'ofereix mai una connexió sense xifratge ni
  s'endevina un nom de servidor. Aplicar una correcció només canvia el formulari: no es
  desa res i el resultat queda marcat com a desactualitzat fins que es torna a provar.
- Si un servidor refusa iniciar la sessió sense xifratge (SMTP 530/538, IMAP
  `PRIVACYREQUIRED`), no es considera que la contrasenya sigui errònia: s'ofereix
  STARTTLS o TLS.
  El nom d'usuari és el mateix per als dos servidors; si l'un l'ha acceptat, no s'ofereix
  canviar-lo quan falla l'altre. Un error amb un servidor intermediari s'atribueix al servidor
  intermediari, no al port de correu. Un servidor SMTP que no demana iniciar la sessió no
  fa fallar la prova, com no fa fallar l'enviament; l'avís recorda que potser només l'ofereix amb
  STARTTLS o TLS.
- El diàleg no desa la contrasenya abans d'una prova satisfactòria. Si la prova falla,
  l'única manera de desar el compte des del diàleg és «Desa igualment», que la persona tria
  explícitament; el nucli el desa sense validar-lo. Un desament després d'una prova
  satisfactòria encara passa per la validació de sempre del nucli (inici de sessió IMAP o
  POP3 i certificat SMTP), que és també la que fa `account.addPassword` cridat sense «Desa
  igualment». En tots els casos el nucli refusa desar un compte de contrasenya o POP3 sense
  contrasenya.
- La prova no deixa cap compte desat ni cap secret al clauer. Un certificat acceptat
  durant la prova es guarda només al diàleg, lligat al servidor i al port per als quals
  es va mostrar, i es desa amb el compte quan aquest es desa; canviar el servidor o el
  port l'oblida.
- La contrasenya només va al servidor que es prova, amb la seguretat que tindria el
  compte. No apareix mai al registre ni a l'informe. El registre de l'aplicació només
  anota el compte, els servidors i els ports, el veredicte de cada servidor i el pas que ha fallat i la
  causa, no les paraules del servidor; «Desa igualment» hi deixa una línia
  pròpia.
- Sense contrasenya escrita, el nucli fa servir la desada del compte amb aquest
  identificador i l'envia als servidors del formulari, encara que s'hagin canviat, com ja
  feia en desar. El pont Go ja no exigeix la contrasenya (abans refusava editar els
  paràmetres del servidor sense tornar-la a escriure, tot i que aquest document deia que es
  conservava); el nucli és l'únic que la requereix.
- POP3 no envia mai la contrasenya sense TLS: com en la connexió real, sense xifratge
  triat es passa a TLS amb STLS, i si el servidor no l'ofereix la prova falla al pas de
  xifratge sense haver enviat res.
- Una prova que encara és en curs quan es tanca el diàleg, es canvia de mode o s'obre un
  altre compte no desa res ni se'n mostra el resultat. Si la prova no es pot fer (falta el
  servidor o el motor no respon), el diàleg ho diu i no desa res.

Cada servidor té un límit de 45 s per a tota la prova. La prova fa servir el servidor
intermediari del compte, o el de l'aplicació si el compte no en té cap. Els textos nous
són en català, en castellà i en anglès; els altres catàlegs fan servir l'anglès.

Verificació: proves del nucli amb servidors IMAP, SMTP i POP3 falsos a 127.0.0.1 per a
cada classe d'error (nom que no es resol, port tancat, TLS en un port sense TLS, STARTTLS
refusat, servidor sense salutació, inici de sessió refusat, servidor que vol xifratge
abans, SMTP sense autenticació, POP3 sense TLS i POP3 que passa a STLS, servidor
intermediari inutilitzable o inaccessible, límit de temps) i per al fet que l'informe,
també el d'una contrasenya errònia, no porta la contrasenya; una prova del gestor que
comprova que la prova no deixa cap compte i que el nucli refusa desar sense contrasenya;
proves Go del pont (paràmetres, registre sense contrasenya, «Desa igualment»); una prova
d'integració contra maddy (IMAP i enviament reals, contrasenya correcta i contrasenya
errònia, cap compte deixat); i proves de la interfície del diàleg. Falten proves
automàtiques amb un certificat que no es valida i amb un servidor intermediari que
funciona (no hi ha cap certificat de prova al nucli), i la prova amb proveïdors reals i a
Windows natiu queda pendent.
