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
avall); els errors conserven el formulari perquè es pugui corregir. La disponibilitat d'OAuth i l'espera al navegador s'expliquen,
en lloc de representar-se amb botons desactivats sense explicació.

No canvia cap contracte de transport Go/Rust, d'àmbit OAuth, de clauer, de confiança en
certificats ni d'edició/reconnexió. No s'afegeix cap servei de xarxa nou de detecció. Es
proporcionen els textos en anglès i en castellà; els altres catàlegs fan servir l'anglès
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
  començament o STARTTLS) i inici de sessió. Cada pas es mostra com a correcte, error, no aplicable
  (sense xifratge triat, servidor intermediari que resol el nom, servidor SMTP que no
  demana iniciar la sessió) o sense provar. La prova SMTP inicia la sessió i surt: no indica
  cap remitent ni cap destinatari.
- Cada error diu què cal corregir, i la interfície n'ofereix la correcció probable: els
  parells de port i seguretat habituals del protocol (993/TLS i 143/STARTTLS, 995/TLS i
  110/STARTTLS, 465/TLS i 587/STARTTLS; primer el mateix port amb l'altra seguretat quan
  és l'error probable), l'altra forma del nom d'usuari (l'adreça sencera o la part abans
  de l'@) o la inspecció del certificat. No s'ofereix mai una connexió sense xifratge ni
  s'endevina un nom de servidor. Aplicar una correcció només canvia el formulari: no es
  desa res i el resultat queda marcat com a antic fins que es torna a provar.
- La contrasenya no es desa abans d'una prova satisfactòria. Si la prova falla, l'única
  manera de desar el compte és «Desa igualment», que la persona tria explícitament; el
  nucli el desa sense validar-lo, però continua refusant-lo sense contrasenya. Un desament
  després d'una prova satisfactòria encara passa per la validació de sempre del nucli.
- La prova no desa res: ni el compte, ni la contrasenya, ni cap certificat fixat. Un
  certificat només es fixa si la persona l'accepta després de veure'l, i llavors es torna
  a provar amb el certificat fixat.
- La contrasenya només va al servidor que es prova, amb la seguretat que tindria el
  compte. No apareix mai al registre ni a l'informe: el registre de l'aplicació només
  anota el veredicte de cada servidor i el pas que ha fallat, no les paraules del servidor.
- En editar un compte sense tornar a escriure la contrasenya, la prova fa servir la desada,
  que es queda al nucli; desar els paràmetres del servidor sense la contrasenya ja no es
  refusa al pont Go.
- POP3 no envia mai la contrasenya sense TLS: una prova POP3 sense xifratge falla al pas
  de xifratge sense haver enviat res.

Cada servidor té un límit de 45 s per a tota la prova. La prova fa servir el servidor
intermediari del compte, o el de l'aplicació si el compte no en té cap.

Verificació: proves del nucli amb servidors IMAP, SMTP i POP3 falsos a 127.0.0.1 per a
cada classe d'error (nom que no es resol, port tancat, TLS en un port sense TLS, STARTTLS
refusat, servidor sense salutació, inici de sessió refusat, SMTP sense autenticació, POP3
sense TLS, servidor intermediari inutilitzable, límit de temps) i per al fet que l'informe
no porta la contrasenya; una prova del gestor que comprova que no es desa res; proves Go
del pont (paràmetres, registre sense contrasenya, «Desa igualment»); una prova
d'integració contra maddy (IMAP i enviament reals, contrasenya correcta i contrasenya errònia); i
proves de la interfície del diàleg. La prova amb proveïdors reals i a Windows natiu queda
pendent.
