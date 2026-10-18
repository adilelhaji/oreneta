# Coherència de les pantalles de l'aplicació (#177)

Estén la [direcció d'art](art-direction.md) aprovada fent servir variables de disseny (tokens) i
components existents. Lliurament dins de #33/#38; no hi ha cap tema, dependència
ni comportament de proveïdor nou.

- Correu, lector, editor de missatges, configuració inicial, configuració,
  calendari, tasques i Kanban fan servir colors semàntics d'èxit, advertiment i
  perill. Els botons d'èmfasi fan servir el text de contrast del tema. Les capes
  sobre continguts multimèdia conserven el text blanc sobre negre; els colors
  d'identitat de compte, calendari i etiqueta i el contingut dels missatges
  conserven el seu significat.
- Les icones Lucide de mida d'interfície fan servir 14/16/20 px amb traços d'1,75.
  S'eliminen les resplendors d'èmfasi decoratives, l'escalat en passar-hi per
  sobre que no és d'arrossegament i el desenfocament no modal. Es conserven la
  retroacció d'arrossegament i de canvi de mida, els fons reals dels diàlegs i les
  previsualitzacions en miniatura de temes i fons de pantalla.
- Persones té un tauler de cerca amb títol i una fitxa de contacte llegible. Per
  sota de 769 px, la fitxa seleccionada substitueix la llista; Enrere restableix el
  focus i la consulta existent. Les respostes de la cerca no mouen el focus. Els
  noms, les adreces i les notes llargs s'ajusten.
- Els assumptes de les tasques són botons natius, separats de completar, editar i
  treure. Els usuaris de teclat poden obrir la conversa; els assumptes i les notes
  llargs i l'estat de venciment s'ajusten, i els objectius de les accions
  continuen disponibles en disposicions estretes.
- Els controls de la capçalera del calendari s'ajusten, la selecció de la
  visualització exposa el seu estat premut i els botons de període anterior i
  següent tenen noms localitzats. La llista de calendaris continua disponible a
  sobre del contingut per sota de 769 px. Els advertiments de sincronització
  s'ajusten en lloc de truncar-se.
- El menú existent de l'aplicació enllaça a Persones, Tasques, Calendari i l'espai
  de treball del correu actual. La navegació compacta manté accessibles aquest
  menú i la tornada al correu a les visualitzacions secundàries. La barra de
  comptes continua oculta a les disposicions estretes del correu.
- Les notificacions emergents fan servir superfícies del tema llegibles i els
  errors de desament de l'editor de missatges s'ajusten amb un rol d'alerta; cap
  dels dos canvis altera quan es considera correcte un desament o una
  sincronització.

## Verificació i límits

Les proves de components cobreixen el focus, la tornada i la cerca de contactes,
les accions independents de les tasques i la navegació compacta i Esc. Les
comprovacions de navegador sobre el punt d'entrada de producció posen a prova
contingut llarg en castellà, l'obertura amb el teclat, clar i fosc, 1440/600 px i
un zoom CSS del 200 %; les captures de pantalla cobreixen Persones, Tasques i
Calendari. Les proves de producció existents cobreixen els controls compartits,
els límits del correu, el lector, l'editor de missatges, la configuració inicial,
la configuració i la selecció. La base sintètica històrica també cobreix les
regressions de Kanban i RSS.

Les proves de l'estat anterior es van capturar a partir de la compilació de
producció prèvia. Abans, les pantalles secundàries estretes s'havien d'obrir a
amplada d'escriptori abans de canviar-ne la mida perquè la barra oculta no tenia
entrades de menú equivalents. Les noves comprovacions hi entren directament a
través del menú compacte. Les proves posteriors del Calendari inclouen una llista
de calendaris sintètica.

Són comprovacions de navegador sintètiques, no una certificació de WebView natiu,
de tecnologies d'assistència ni de proveïdors. #33/#38 continuen obertes per a
l'acceptació completa de fluxos de treball i nativa, l'empaquetament de fonts per
treballar sense connexió i qualsevol contracte específic de pantalla pendent. Es
conserven les preferències existents de tema, font i densitat. No se substitueix
cap instal·lador.
