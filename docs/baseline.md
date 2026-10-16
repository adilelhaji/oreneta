# Línia base funcional i visual

## Abast

Codi de referència: `fe72de7c777718b2649969d18d40be84b96bfd0c` (2026-09-08).
Els PR #11, #18, #20 i #58 estan integrats. La [CI de main](https://github.com/adilelhaji/oreneta/actions/runs/34221227862)
va superar Go, Rust, frontend, mòbil, integració amb Maddy i política de fluxos de treball.
Aquella execució és anterior a la fixture (dades de prova) de navegador; els resultats nous del navegador corresponen a la CI del
PR propi de #59 o de main i no s'han d'atribuir a aquesta execució històrica de referència.

Aquesta és una línia base d'enginyeria interna, no l'entrada al pilot ni l'aprovació de proveïdors.
L'ADR-0001 (Wails/Rust/Go/React natiu) i l'ADR-0002 (enllaços explícits a etiquetes remotes)
no canvien. #22 és responsable dels participants del pilot, la matriu de proveïdors i plataformes i els criteris de
sortida; #23 és responsable de l'acceptació completa de la línia base.

## Contracte d'evidència visual

L'entrada de prova aïllada `frontend/baseline` reutilitza components, estils
i temes integrats de producció. No arrenca l'aplicació ni accedeix a cap backend real. Les adreces
sintètiques fan servir `example.test`; les dades, el rellotge, la configuració regional, el fus horari i la mida de visualització són fixos.
Les ordres simulades estan permeses explícitament; les ordres desconegudes es rebutgen. No hi ha cap
alternativa simulada al pont de producció ni a l'entrada de l'aplicació.
La fixture té camps de compte de marcador de posició però cap credencial ni secret. L'arrencada
de l'aplicació no hi és i el transport en memòria no es pot connectar, independentment de
la marca `paused` del compte. Això és evidència de components amb estat precarregat, no prova
d'interacció amb el backend ni de lliurament correcte de correu.

La CI captura la safata d'entrada, el lector, el redactor i les tasques en clar/fosc a 1440/1024/600 píxels.
Els artefactes identifiquen el SHA realment provat i la suma de verificació de la fixture. Les captures de
Chromium són evidència de components, no una prova extrem a extrem en un webview natiu. Els valors per
defecte Indigo existents es capturen tal com són: la direcció cobalt/marí aprovada és l'objectiu de
la comparació que es farà a #32/#33, i aquesta línia base no l'aplica de manera silenciosa.
Les importacions de fonts remotes s'eliminen a la compilació només de prova. Les fonts alternatives de la plataforma
poden canviar les mètriques dels glifs: les captures de pantalla no són comparables píxel a píxel entre diferents
instal·lacions de SO/fonts. La representació nativa de WebKitGTK/WKWebView/WebView2, l'IME i
la integració de finestres de Wails no es validen amb aquest arnès de Chromium. El flux de treball
de validació de Windows té una comprovació separada del zoom natiu de WebView2 que fa servir la ruta del teclat
i UI Automation; la seva evidència no és intercanviable amb aquestes captures.

Amfitrió de validació local: Windows. Les cadenes d'eines de Go/WebKitGTK, Rust, Docker/Maddy i mòbil
no estan disponibles localment; els seus resultats de CI es registren per separat.
L'execució inicial del frontend a l'amfitrió Windows en castellà va tenir 770 proves superades i
quatre fallades d'expectatives de data només en anglès, registrades a #60. El comportament de la configuració regional
de producció no es canvia perquè aquestes proves passin.
La correcció de #60 comprova la sortida regional nativa i les opcions de format exactes,
incloses les branques del mateix dia i d'any diferent. La suite afectada va superar 41 proves
en aquell amfitrió en castellà; els resultats de la suite completa i de la CI corresponen al commit de lliurament de #60.

## Reproducció a la CI

El job (tasca de CI) `frontend` instal·la els fitxers de bloqueig de l'arrel i del frontend, genera i
valida els catàlegs, executa les proves de catàlegs, la comprovació de tipus i les proves de Bun, i després instal·la
el Chromium fixat de Playwright i executa `bun run baseline:verify`. L'executor de proves
gestiona el seu propi servidor Vite només de bucle local (loopback); no és un script de desplegament. L'executor
de la fixture és Playwright 1.63.0 amb Bun 1.4.2 i Node 22 a la CI.

Cadascuna de les 24 captures produeix un PNG i una procedència JSON (SHA del checkout (còpia de treball), SHA del flux de treball,
suma de verificació de la fixture, navegador/entorn d'execució i paràmetres de pantalla). La CI puja
l'artefacte `baseline-<workflow SHA>` amb l'informe HTML i les traces de fallada. Els SHA de checkout
dels PR poden ser el commit de fusió sintètic de GitHub; la procedència registra tots dos
valors en lloc d'etiquetar erròniament les proves del cap de branca com a evidència posterior a la fusió.

Defecte històric (#34, corregit per #85): les regles de visibilitat estrictes `<600px`
deixaven el lector fora de la finestra de visualització de 600 a 768 px mentre la llista encara
ocupava tota l'amplada. Ara totes dues captures del lector a 600 px exigeixen visibilitat positiva
a la finestra de visualització. Vegeu [límits del correu](design/mail-boundaries.md) per a les comprovacions de límits
de producció i equivalents de zoom; l'evidència del zoom natiu s'adjunta per separat
a l'execució de validació de Windows.

## Registre de capacitats

| Capacitat | Implementació / evidència automatitzada | Disponibilitat i límits |
|---|---|---|
| Correu IMAP/SMTP i MIME complex | Proves Rust/Go; integració sintètica amb Maddy; proves de l'analitzador IMAP incorporat (#19) | Implementat; sense certificació de lliurament amb proveïdors reals |
| Etiquetes de Gmail | #20, proves d'emmagatzematge/traducció | Enllaços explícits; interoperabilitat real amb Gmail/OAuth no verificada |
| Exchange/delegació/calendari | Backend EWS, proves de l'analitzador i exemples de sondeig | Compatibilitat de tenant (inquilí de Microsoft 365)/plataforma no verificada; #46/#48 són responsables de la validació de continuïtat/delegació |
| Contactes | Codi CardDAV/Google/Exchange i proves d'anàlisi | El risc de sincronització incompleta continua a #28 |
| Tasques locals vinculades a missatges | #18, proves Rust/Go/React | Només locals; #42 és responsable de la validació de recuperació |
| PGP/S/MIME i còpia de seguretat d'identitat | #11, proves de criptografia i de còpia de seguretat | La interoperabilitat/confiança externa continua a #9/#12/#49; no certificat per simulacions |
| Suggeriments de correu brossa | #18, proves Rust/React | Només suggeriments; l'explicabilitat i la seguretat davant repeticions continuen a #50 |
| Sistema de disseny | Components/temes actuals; captures sintètiques de navegador | La direcció artística aprovada continua parcialment sense implementar; sense certificació d'accessibilitat |
| Versions publicades | Porta de SHA exacte de #58 i 41 proves | Administració de branques/etiquetes de git i portes restants a #26; no s'ha llançat cap publicació |

## Troballes de fiabilitat

| Troballa | Responsable | Estat a la línia base |
|---|---|---|
| H01: abast del conjunt revisat de Sweep | #27 | Hipòtesi; encara cal una reproducció executable |
| H02: substitució CardDAV incompleta | #28 | Hipòtesi; encara cal una reproducció executable |
| H03: enviament/reintent incert i arxivament a Enviats | #29 | Hipòtesi; encara cal una reproducció executable |
| H04: ordenació/paginació i identitat de files obsoletes | #30 | #63 cobreix la propagació al frontend i les vistes obsoletes; #65 cobreix la paritat de claus SQL/cursor; l'abast restant és a [paginació de la bústia](mailbox-paging.md) |
| H05: semàntica de cerca entre proveïdors | #31 | Hipòtesi; encara cal una reproducció executable |
| H06 | #23 | Definició absent del repositori i dels cossos d'incidència inspeccionats; ni inventada ni reproduïda |

Són riscos registrats, no afirmacions d'incidents de producció observats. #23 continua
oberta fins que es completin les reproduccions i l'evidència restants.
