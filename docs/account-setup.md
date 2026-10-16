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
diferent. Els paràmetres detectats o endevinats no són prova d'autenticació. Desar el
compte continua sent la validació de la connexió; els errors conserven el formulari
perquè es pugui corregir. La disponibilitat d'OAuth i l'espera al navegador s'expliquen,
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
