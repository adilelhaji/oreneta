# Límits de les subfinestres del correu (#85)

Per sota de 769 píxels CSS, el correu fa servir una sola subfinestra: la llista o
la conversa, segons l'estat existent `mobilePane`. La barra de comptes s'oculta;
el menú existent de la llista i el selector de carpetes continuen disponibles.
Enrere torna a la llista sense tancar la conversa. A partir de 769px, l'amplada
desada de la llista i el lector coexisteixen; el lector es pot encongir dins de
l'espai restant.
Crear un editor de missatges complet també selecciona la subfinestra de la
conversa, inclosos els punts d'entrada de teclat i de mailto; la fallada per no
haver-hi cap compte que pugui enviar deixa la subfinestra sense canvis.
El peu de l'editor de missatges ajusta els seus controls a l'amplada real de la
subfinestra perquè Envia, Descarta i l'estat de l'esborrany continuïn sent
accessibles fins i tot en una subfinestra dividida estreta d'escriptori.
La navegació completa de carpetes
conserva el seu límit independent de >1024px. No s'afegeix cap escoltador de canvi
de mida ni cap estat nou.

El menú compacte de l'aplicació també enllaça a Persones, Tasques i Calendari
(#177). Aquestes superfícies conserven el menú i una tornada a l'espai de treball
del correu actual mentre la barra està oculta; els seus canvis es detallen a
[coherència de les pantalles](screen-consistency.md).

El límit anterior de la llista a amplada completa (769px) no coincidia amb el de
visibilitat (600px), i deixava el lector retallat entre 600 i 768px. Les proves
de producció cobreixen 599/600/601, 768/769 i 1024/1025, tots dos temes, el
context de lector, enrere, selecció, carpeta i editor de missatges, i els límits
de l'estructura de l'aplicació. La base sintètica de components ara exigeix
contingut visible a 600px en lloc d'acceptar el defecte conegut.

Una finestra de 1440px amb un zoom del 200% s'exercita amb la disposició
equivalent de 720 píxels CSS amb un factor d'escala del dispositiu de 2.
L'executor de validació de Windows exercita, a més, el camí real de Ctrl+roda del
ratolí de WebView2: verifica el focus en primer pla i l'entrada injectada,
comença amb el factor configurat del 100%, aplica el zoom amb la roda per ampliar
i reduir, i fa servir Windows UI Automation per verificar que la disposició de
l'editor de l'adreça electrònica de la configuració inicial canvia i continua
visible dins de la finestra nativa, mentre les opcions de proveïdor continuen
presents a l'arbre d'accessibilitat. UI Automation no pot llegir el `ZoomFactor`
privat de WebView2, de manera que això és una prova nativa de la disposició amb
zoom, no una certificació del factor exacte del 200%. El tacte, l'IME, la
interoperabilitat amb proveïdors i el comportament de l'instal·lador continuen
sent mancances separades. No exercita el lector de la bústia, les accions dels
missatges ni l'editor de missatges; això continua sent feina d'acceptació nativa
separada.

L'execució nativa 37429870187 del 2026-10-06 va revelar una discrepància en la
prova anterior: Wails desactiva les acceleracions de teclat del navegador,
incloses Ctrl+més/menys/zero. Aquestes dreceres continuen sense ser compatibles
([#181](https://github.com/adilelhaji/oreneta/issues/181)); el zoom CSS no
substitueix el zoom natiu.
La validació fa servir el gest admès de Ctrl+roda, verifica el creixement real,
l'accessibilitat amb el teclat mitjançant el desplaçament vertical, la reducció i
la restauració, i ho repeteix després de reiniciar. Avança el focus una vegada i
torna al camp de l'adreça electrònica abans d'exigir-ne els límits complets dins
de la finestra. Amb un zoom alt no cal que tot el formulari de configuració
inicial càpiga a la part visible sense desplaçar-se; un editor retallat o
inaccessible continua fallant. La cobertura de navegador també comprova
l'accessibilitat amb el teclat a 410x280 píxels CSS. Cada execució comença
explícitament al 100%. La mancança de la drecera de teclat continua separada de
l'acceptació de la instal·lació, igual que les comprovacions del lector, de
l'editor de missatges i de les tecnologies d'assistència.
Vegeu [zoom de WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings#get_iszoomcontrolenabled)
i [comportament de les acceleracions del navegador](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3#put_arebrowseracceleratorkeysenabled).
