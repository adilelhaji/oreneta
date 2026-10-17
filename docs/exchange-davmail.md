# Ús de comptes d'Exchange mitjançant DavMail

Oreneta parla IMAP/SMTP. Moltes organitzacions tenen Microsoft Exchange amb IMAP/SMTP
desactivat o bloquejat pel tallafoc, i només exposen Outlook Web Access (OWA) i EWS sobre
HTTPS. [DavMail](https://davmail.sourceforge.net/) salva aquesta distància: s'executa en
local, parla EWS amb el servidor Exchange i serveix IMAP/SMTP a localhost perquè Oreneta
s'hi connecti.

```
Oreneta ──IMAP/SMTP (localhost)──▶ DavMail  ──EWS over HTTPS──▶  Exchange
```

Aquesta configuració es va validar amb un servidor Exchange local (on-premises) amb tots
els ports IMAP/SMTP filtrats.

## 1. Instal·lació de DavMail

La majoria de distribucions de Linux l'empaqueten (`apt install davmail`,
`dnf install davmail`); les compilacions per a Windows i macOS són al
[lloc web de DavMail](https://davmail.sourceforge.net/download.html).

## 2. Configuració de DavMail

`davmail.properties` mínim per a l'ús sense interfície gràfica:

```properties
davmail.server=true
davmail.mode=EWS
# Point at the EWS endpoint directly. Using the /owa/ URL also works but goes
# through OWA form-based login, which is less reliable (intermittent 400s).
davmail.url=https://mail.example.org/EWS/Exchange.asmx

# Local ports, only reachable from this machine
davmail.imapPort=1143
davmail.smtpPort=1025
davmail.allowRemote=false
davmail.bindAddress=127.0.0.1

# Serving an exact message size requires downloading the message; approximate
# sizes make folder listings much faster through EWS.
davmail.imapAlwaysApproxMsgSize=true
# Enable IMAP IDLE so Oreneta gets push notifications instead of polling
davmail.imapIdleDelay=1
```

Executeu-lo amb `davmail /path/to/davmail.properties` (o activeu-lo com a servei: a
Linux, una unitat d'usuari de systemd amb
`ExecStart=/usr/bin/davmail %h/.davmail.properties` funciona bé).

## 3. Afegiment del compte a Oreneta

Feu servir la configuració manual (la detecció automàtica no pot trobar una passarel·la a
localhost):

|            | Entrant (IMAP)   | Sortint (SMTP)   |
| ---------- | ---------------- | ---------------- |
| Servidor   | `127.0.0.1`      | `127.0.0.1`      |
| Port       | `1143`           | `1025`           |
| Xifratge   | Cap              | Cap              |
| Nom d'usuari | la vostra adreça de correu electrònic, o `DOMAIN\user` tal com s'usa a OWA | el mateix |
| Contrasenya | la vostra contrasenya d'Exchange | la mateixa |

El text sense xifrar en aquestes connexions no és cap problema: mai no surten de la vostra
màquina, i DavMail parla amb el servidor Exchange per HTTPS. DavMail reenvia la vostra
contrasenya a Exchange i només Oreneta l'emmagatzema.

## Resolució de problemes

**"Could not connect… retrying" mentre el correu arriba a poc a poc, o
`sync <folder>: timed out after 30s` al registre.** DavMail baixa el missatge complet
d'Exchange per servir cada capçalera, de manera que sincronitzar una carpeta gran
mitjançant EWS és molt més lent que l'IMAP directe i pot superar el límit de temps
per defecte de 30 s per carpeta de la sincronització d'Oreneta. Augmenteu-lo amb la
variable d'entorn `MERON_SYNC_TIMEOUT` (en segons), p. ex. `MERON_SYNC_TIMEOUT=300`. Per a
una instal·lació amb Flatpak:

```
flatpak override --user io.github.adilelhaji.oreneta --env=MERON_SYNC_TIMEOUT=300
```

**L'inici de sessió falla des d'Oreneta però funciona a OWA.** Proveu la forma
`DOMAIN\user` del vostre nom d'usuari, i feu que `davmail.url` apunti a
`…/EWS/Exchange.asmx` en lloc de `…/owa/`. El registre de DavMail
(`davmail.logFilePath`) mostra la resposta del costat d'Exchange.

**Només passa pel pont el correu.** Aquesta configuració cobreix el correu. DavMail també
pot exposar el calendari (CalDAV) i la llibreta d'adreces (LDAP/CardDAV), però Oreneta no
els consumeix.

## Comptes d'Exchange natius (EWS)

Quan el punt final (endpoint) EWS del servidor és accessible, el tipus de compte
**Exchange** hi parla directament, sense DavMail pel mig. A més del correu, el calendari,
el directori i les respostes automàtiques, cobreix (ADR-0058):

- **Carpetes per camí:** les subcarpetes apareixen sota les seves carpetes pare
  (`Inbox/Clients`) i es poden moure arrossegant-les o amb "Move folder to…"
  (`MoveFolder`). Primer es comprova el moviment amb un llistat de carpetes nou i mai no
  es repeteix. Abans d'això, una subcarpeta d'Exchange s'anomenava només pel seu propi nom
  (`Clients`). El primer llistat després de l'actualització trasllada al camí tot el que
  es guardava amb aquell nom: el correu de la memòria cau, les regles del compte, les
  converses posposades, les tasques, l'arxivament automàtic, els preferits, els colors,
  les columnes del tauler i les cerques desades. L'única cosa que no es pot distingir és un nom que
  compartien dues carpetes: aquella memòria cau es torna a llegir.
- **Confirmacions de lliurament:** se sol·liciten a Exchange en la petició de cada
  missatge (`IsDeliveryReceiptRequested`) quan l'interruptor de l'editor de missatges és
  activat. Encara no s'ha verificat que un servidor Exchange real ho respecti al costat
  del MIME.
- **Contactes i llistes de distribució:** Settings → People → "Read Exchange contacts"
  incorpora la carpeta de contactes i, com a llibretes pròpies, les carpetes de contactes
  que té a sota (ADR-0066). Les persones de totes es poden crear, editar i suprimir; les
  llistes de distribució són grups de contactes que es poden crear, canviar de nom,
  modificar i suprimir. Una persona o una llista modificada en un altre lloc des que es va
  llegir no se sobreescriu mai: no es desa res i es torna la còpia del servidor. Exchange
  guarda tres adreces per contacte; un canvi que no hi cap no s'envia. Una nota amb format
  HTML que es modifica aquí es desa com a text. Encara no s'ha verificat amb un servidor
  Exchange real (N5).
- **Tasques:** Tasks → "Exchange tasks of …" manté la carpeta de tasques del compte com a
  llista, sincronitzada com una de CalDAV, incloses les regles de repetició que EWS
  comparteix amb l'editor.

Mitjançant DavMail no hi ha cap d'aquestes funcions: només fa de pont del correu.
