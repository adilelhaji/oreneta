# Registre d'acceptació de paritat (#22)

Les [files llegibles per màquina](emclient-parity-acceptance.json) concreten el
[full de ruta](emclient-parity-plan.md). Abast: S01, l'auditoria de les famílies de
configuració i files per als dominis lliurats (calendari, notes, perfils, Graph, POP3,
enllaços al núvol, plataformes). No és una matriu de proveïdors completa ni una
afirmació de cobertura total de la configuració. #22 continua oberta per a l'evidència
nativa/de proveïdor i l'auditoria de detall.

El [paquet d'acceptació de proveïdors](provider-acceptance.md) (#145/#184) afegeix un
informe per operació per a la bateria d'integració IMAP/SMTP aïllada existent i
procediments dedicats per a comptes reals. Un informe de fixtures (dades de prova) favorable no promou
cap fila nativa/de proveïdor del registre d'acceptació a verified.

## Resum d'estat (2026-10-12)

48 rows: 1 verified, 24 implemented-unverified, 23 partial, 0 absent, 0 unassessed, 0 blocked.
L'única fila verified (SET-16A) no necessita evidència nativa ni de proveïdor.
Encara no hi ha evidència nativa de Windows (N4) ni de proveïdor real (N5); està
planificada una sola vegada sobre la versió final, de manera que totes les files que la
requereixen es mantenen a `implemented-unverified` o per sota. Les files CAL-01, CAL-02,
NOTE-01, ACC-01 i GRAPH-01 es van afegir el 2026-10-12 per a treball lliurat que no tenia
fila.
El 2026-10-15 (#210, ADR-0057) SET-07 va incorporar els moviments de carpeta a Microsoft
Graph i SET-11 les confirmacions de lliurament de Graph i la lectura dels informes de
lliurament i de lectura entrants; totes dues es mantenen `partial`, perquè les parts
d'Exchange (EWS) són absents.
El 2026-10-16 (#225, ADR-0056) SET-29 va incorporar l'avís agrupat d'escriptori dels
recordatoris perduts mentre la màquina dormia o l'aplicació era tancada; es manté
`implemented-unverified` (evidència nativa pendent; el telèfon encara no els mostra).
El 2026-10-16 (#226, ADR-0061) SET-27 va incorporar la disposició de dreta a esquerra
per a l'àrab, amb comprovacions d'entrada de producció en àrab per a la bústia, el lector
i l'editor de missatges i per a persones, tasques, notes, calendari, xat i configuració;
es manté `partial`, perquè falten l'evidència nativa de l'IME i la nativa de Windows.
El 2026-10-17 (#245) l'acció de marcar com a brossa, que fins llavors només era al menú
contextual de la conversa, es va oferir també com a botó visible a la capçalera del lector
i a la barra de selecció múltiple («Marca com a brossa»; a la carpeta de brossa, «No és
brossa»), amb el mateix avís i la mateixa opció de desfer. Cap fila no canvia d'estat
(SET-07, S01-06): l'evidència nativa de Windows continua pendent.
El 2026-10-17 (#244) CAL-02 va registrar una fallada de la prova nativa de Windows del
2026-10-16 (compilació `81ec18fb`, de desenvolupament intern, amb els registres OAuth
heretats): un compte de Gmail afegit amb l'inici de sessió de Google no mostrava cap
calendari, i el registre no en deia el motiu. Ara cada error de sincronització del
calendari s'escriu al registre amb el compte i el motiu; `calendar.syncError` porta un
`reason` (`api_disabled`, `needs_consent`, `needs_reconnect` o `other`), i la interfície
mostra l'error de cada compte, amb la causa quan Google la diu. Afegir un compte de Gmail
també registra si Google va concedir el permís del calendari. La causa d'aquella fallada
no s'ha confirmat: la hipòtesi és que l'API de Google Calendar no està activada al projecte
de Google Cloud heretat (#144). La fila es manté `implemented-unverified` fins que una
prova nativa nova ho aclareixi.
El 2026-10-17 (#243) la conversa que queda oculta sota una pestanya de redacció o de
lector oberta, a més d'invisible i `aria-hidden`, ara també és inerta (`inert`): mentre
durava una transició (la del quadre de resposta ràpida), els seus controls continuaven
visibles i podien rebre el focus, i l'auditoria axe hi trobava de tant en tant
`aria-hidden-focus` a 1024 px (i un cop a 1440 px en fosc). Les auditories axe de
l'entrada de producció en català esperen que acabin les transicions. Una prova nova a
1024 px, en anglès i en català, en clar i en fosc, allarga les transicions de l'aplicació,
recorre la pàgina amb Tab i Maj+Tab i comprova que el focus no s'atura mai a la regió
oculta. Cap fila no canvia d'estat (SET-27, #37):
l'evidència nativa de Windows continua pendent.
El 2026-10-17 (#254, ADR-0005) desfer «Marca com a brossa» o «No és brossa», d'una
conversa o d'una selecció, també desfà el que aquell judici havia ensenyat al filtre
après: els comptadors del remitent i de les paraules de l'assumpte tornen a l'estat
d'abans, i un judici posterior del mateix missatge o d'un altre missatge del mateix
remitent es manté. SET-12 continua `implemented-unverified`: l'evidència nativa de
Windows continua pendent.
El 2026-10-17 (#257, ADR-0066) SET-19 va incorporar, als comptes d'Exchange (EWS), les
carpetes de contactes que hi ha sota Contactes, cada una com a llibreta pròpia, i l'edició
de les persones (crear-les, editar-les i suprimir-les) amb la clau de canvis llegida, sense
sobreescriure mai un canvi remot i sense enviar res més que el que ha canviat, provades amb
respostes SOAP enregistrades. Es manté `partial`: falten els grups i els contactes de Graph
(#144) i l'evidència nativa de Windows; l'evidència amb un servidor Exchange real (N5)
també és pendent.
El 2026-10-17 (#256, ADR-0064) SET-21 va incorporar la llista de qui pot veure l'estat propi al xat
(la llista del servidor, desconeguda fins que respon, amb «Deixa de compartir» després de
confirmar-ho), el silenci d'una conversa directa, privada o de grup (sense avisos, ni tan sols
de mencions, però comptada com a no llegida) i les mencions sense llegir de cada grup i del
compte. L'absència automàtica per inactivitat necessita una API nova del sistema: el propietari va
triar l'opció A de l'ADR-0065, que encara no està implementada (#265). La fila es manté `partial` (hi falten aquest punt i
l'evidència nativa de Windows).
El 2026-10-17 (#273) SET-07 va incorporar amagar carpetes de l'arbre de carpetes i tornar-les
a mostrar («Amaga la carpeta», «Mostra les carpetes amagades», «Torna a mostrar la carpeta»),
amb les subcarpetes incloses, com a preferència local (`folder_hidden`) que no arriba mai al
servidor: les carpetes amagades es continuen sincronitzant, i «Opcions de cerca» diu si la
cerca les inclou. La safata d'entrada no es pot amagar. Cap fila no canvia d'estat: SET-07
es manté `partial` i l'evidència nativa de Windows continua pendent.
El 2026-10-17 (#277, ADR-0047 esmenada el 2026-10-18, `docs/design/quicktext-placeholders.md`) SET-10 va incorporar, per a cada compte, l'opció de triar on va la
signatura a les respostes i els reenviaments: amb el text propi (com fins ara), damunt de la citació o sota la
citació, com a preferència local (`signature_placement`). Cap fila no canvia d'estat: SET-10
es manté `implemented-unverified` i l'evidència nativa de Windows continua pendent.
El 2026-10-17 (#269) la configuració manual IMAP/POP3/SMTP va incorporar «Prova la
connexió»: comprova el servidor d'entrada i el de sortida per separat, pas a pas (DNS, TCP,
TLS i inici de sessió), diu què cal corregir en cada error i n'ofereix la correcció
probable (parells de port i seguretat, forma del nom d'usuari, inspecció del certificat)
sense desar res. «Desa el compte» fa la prova primer, i la contrasenya no es desa abans
d'una prova satisfactòria tret que la persona triï «Desa igualment». Vegeu
[account-setup.md](account-setup.md). Cap fila no canvia d'estat: no hi ha cap fila per a
la configuració manual de comptes (S15-01, de POP3, tracta la baixada del correu i es
manté `implemented-unverified`), i l'evidència nativa de Windows (N4) i amb proveïdors
reals (N5) continua pendent; les proves amb servidors falsos i amb maddy (MAIL-17 del
paquet d'acceptació de proveïdors) són sintètiques.
El 2026-10-18 (#306, pas 1 d'ADR-0068, `docs/design/app-regions.md`) la finestra va
incorporar regions amb nom i F6 / Maj+F6 per passar d'una a l'altra, sense cap canvi visual:
un sol estat de mòdul, els diàlegs i els avisos fora de `<main>`, `<main>` amb el nom del
mòdul i la barra vertical amb el nom «Mòduls». F6 també actua des d'un camp de text i des del
missatge HTML, i no fa res si hi ha un diàleg modal obert (l'editor i el detall d'un
esdeveniment, la revisió del context de l'assistent i la galeria ara es declaren modals).
Les proves automàtiques de límits, de dreta a esquerra i de zoom es mantenen, i se n'hi
afegeixen de noves: F6 en anglès, en català i en àrab, i les regles de regions d'axe. Cap fila no canvia d'estat (S01-04, S01-05, SET-02,
SET-23, SET-27): l'evidència nativa de Windows continua pendent, i també cal comprovar que F6
arriba a la pàgina a WebView2 i a WebKitGTK.
El 2026-10-17 (#287) l'aparença (S01-01, S01-02) va incorporar la primera peça del
redisseny aprovat pel propietari: dos tons de superfície a tots els temes (el marc per a
la finestra, les capçaleres i el panell de carpetes; el contingut per a les llistes i el
lector), el token `--me-border-input` per a la vora dels camps (3:1), l'anell de focus
d'accent sòlid i els radis de 4/6/8/12 px. Els temes personalitzats desats conserven els
seus colors i s'hi afegeix la vora de camp derivada. Vuit temes integrats mantenen l'accent per
sota de 4,5:1 com a text, com abans; corregir-ho espera la decisió del propietari. Cap
fila no canvia d'estat: l'evidència nativa de Windows continua pendent.

| Row | Issue | Section | Status | N | P |
|---|---|---|---|---|---|
| S01-01 | #83 | Appearance/Themes | implemented-unverified | yes | - |
| S01-02 | #83 | Appearance/Themes | implemented-unverified | yes | - |
| S01-03 | #84 | Appearance/Lists; Mail/Conversations | implemented-unverified | yes | - |
| S01-04 | #84 | Appearance/Layout | implemented-unverified | yes | - |
| S01-05 | #85 | Appearance/Layout | implemented-unverified | yes | - |
| S01-06 | #34 | Appearance/Lists | implemented-unverified | yes | - |
| S01-07 | #35 | Mail/Read | implemented-unverified | yes | - |
| SET-01 | #114 | General/Notifications | implemented-unverified | yes | - |
| SET-02 | #114 | General/Shortcuts; Swipe | partial | yes | - |
| SET-03 | #113 | General/Backup; Storage | partial | yes | - |
| SET-04 | #54 | General/Password protection | partial | yes | - |
| SET-05 | #35 | General/Print | implemented-unverified | yes | - |
| SET-06 | #105 | General/Spell Checker | partial | yes | - |
| SET-07 | #87 | General/Folders | partial | yes | - |
| SET-08 | #33 | Appearance/Toolbars | partial | yes | - |
| SET-09 | #39 | Mail/Replies and Forwards | implemented-unverified | yes | - |
| SET-10 | #88 | Mail/Templates and Signatures; QuickText | implemented-unverified | yes | - |
| SET-11 | #107 | Mail/Privacy; Receipts | partial | yes | - |
| SET-12 | #50 | Mail/Blacklist and whitelist | implemented-unverified | yes | - |
| SET-13 | #112 | Mail/Automatic archiving | implemented-unverified | yes | - |
| SET-14 | #106 | Mail/Translation | implemented-unverified | yes | - |
| SET-15 | #45 | Mail/Watch for Reply | implemented-unverified | yes | - |
| SET-16A | #51 | Mail/Artificial Intelligence | verified | - | - |
| SET-16 | #52 | Mail/Artificial Intelligence | implemented-unverified | yes | - |
| SET-17 | #49 | Signing and Encryption/Policies; Key Lookup Services | partial | yes | - |
| SET-18 | #100 | Calendar/General; Weather | partial | yes | - |
| SET-19 | #41 | Contacts/General | partial | yes | - |
| SET-30 | #53 | Performance/Completion | partial | yes | - |
| SET-31 | #54 | Privacy/Diagnostics; Backup; Updates | implemented-unverified | yes | - |
| SET-20 | #103 | Tasks/General | partial | yes | - |
| SET-21 | #111 | Chat/General | partial | yes | - |
| SET-22 | #109 | Online Meetings/General | partial | yes | - |
| SET-23 | #86 | Widgets/General | partial | yes | - |
| SET-24 | #54 | Advanced/Logging | implemented-unverified | yes | - |
| SET-25 | #112 | Settings/Import and Export | partial | yes | - |
| SET-26 | #116 | Settings/QR Export | partial | yes | - |
| SET-27 | #37 | General/Language | partial | yes | - |
| SET-28 | #29 | Mail/Send; General/Confirmations | implemented-unverified | yes | - |
| SET-29 | #100 | General/Reminders | implemented-unverified | yes | - |
| S15-01 | #97 | Accounts/POP3 | implemented-unverified | yes | yes |
| S14-01 | #108 | Compose/Attachments | partial | yes | yes |
| S16-01 | #115 | Platforms/macOS and Linux | partial | yes | - |
| S16-02 | #117 | Reference/eM Client 11 | partial | - | - |
| CAL-01 | #102 | Calendar/Invitations | implemented-unverified | yes | yes |
| CAL-02 | #101 | Calendar/Accounts | implemented-unverified | yes | yes |
| NOTE-01 | #104 | Notes/General | partial | yes | - |
| ACC-01 | #99 | Accounts/Profiles; Account groups | implemented-unverified | yes | - |
| GRAPH-01 | #143 | Accounts/Microsoft 365 | partial | yes | yes |

N/P: evidència nativa/de proveïdor requerida abans de `verified`. Vegeu el JSON per saber
què hi ha o què falta en cada fila i el commit exacte i el fitxer de proves darrere de
cada element d'evidència automatitzada.

## Procedència i estats

La instantània identifica, per a cada fila, el main actual, la pàgina/versió d'origen, la
plataforma, la incidència responsable, el límit del codi, el nivell d'evidència actual i
un procediment d'acceptació concret. S01 fa servir les fixtures sintètiques existents a
frontend/baseline/fixtures.ts i la prova d'entrada de producció a
frontend/e2e/startup.e2e.ts. Mantingueu idèntics el contingut, el rellotge, el fus horari,
les fonts, la configuració regional, la finestra de visualització i l'aparença perquè les
captures de pantalla siguin comparables. Les captures de referència històriques no
demostren el comportament natiu/de proveïdor actual.

Les files SET-01 a SET-31 anomenen famílies de configuració de l'índex de la documentació
oficial de la versió 10.0. El 2026-10-12 cadascuna es va avaluar respecte del codi i les
seves proves: `present` diu què existeix i què falta, i `partial` vol dir que part del
resultat és absent. Una prova planificada no és evidència de prova.
Cada element d'evidència ha d'indicar un commit exacte i un URL d'artefacte/resultat o un
camí del repositori; una fila verified requereix els registres automatitzats i tots els
natius/de proveïdor aplicables.

## Rúbrica visual de S01

- 1440 px: la navegació de carpetes etiquetada, la llista de correu i el lector, visibles
  alhora.
- 1024 px: l'accés essencial a carpetes/comptes continua accessible en controls compactes.
- 599/600/601 px: el lector seleccionat és visible amb una navegació de tornada/llista
  utilitzable; la redacció i les accions no desborden el contenidor. Comproveu 1024/1025 px
  per separat.
- Els tokens de disseny cobalt dels perfils nous segueixen art-direction.md; els
  temes/modes desats no es reescriuen. Totes dues aparences conserven la llegibilitat del
  text, els controls i la selecció.
- Registreu per separat els estats de focus, fila oberta, no llegit i selecció múltiple;
  l'ús amb teclat no ha de seleccionar ni actuar sobre missatges d'un altre compte.
- Les etiquetes/assumptes localitzats llargs, els estats buit/de càrrega/d'error, l'HTML
  ample i el zoom del 200 % han de conservar les accions essencials. Es manté el moviment
  reduït.
- La revisió de pantalla comprova la geometria, la tipografia, la jerarquia i la compleció
  de tasques, no un percentatge de semblança endevinat ni gràfics propietaris copiats.

## Actualització i validació

Els PR responsables només actualitzen les files fins al nivell d'evidència realment
obtingut. Les execucions locals al navegador amb un pont Wails simulat són sintètiques;
l'execució nativa a Windows, la connectivitat amb comptes reals i el lliurament requereixen
evidència independent. Afegiu files específiques de proveïdor en lloc de reetiquetar una
prova genèrica com a certificació d'un proveïdor.

La CI executa scripts/ci/parity-ledger.test.cjs mitjançant el job (tasca de CI) workflow-policy
existent. Valida les referències, la unicitat dels ID, els camins del repositori, els
estats i l'evidència requerida per a les files verified. S01 acaba amb els seus PR
d'implementació reals, no amb aquest PR del registre d'acceptació.
