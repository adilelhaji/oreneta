# ADR-0059: Agenda a la barra lateral, subfinestres redimensionables i secció recordada

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #212 en l'opció més prudent); pendent de revisió del
  propietari al final del pla.
- Data: 2026-10-15.
- Abast: #212 (fila SET-23 del registre d'acceptació, «Widgets» d'eM Client
  10.4), sobre la barra lateral contextual de #86.

## Decisió

- **On és l'agenda:** és una secció més de la barra lateral de
  detalls de la conversa, al costat de multimèdia i fitxers. El seu contingut
  no depèn de la conversa oberta ni espera que es carregui; l'accés
  sí: la barra lateral només existeix amb una conversa oberta al
  lector. No hi ha una subfinestra de widgets independent (en arrencar sense
  conversa, ni a Calendari, Tasques, Contactes o Notes); queda per a
  una incidència posterior, per decisió del propietari.
- **Què mostra:**
  - els propers 7 dies, avui inclòs, comptats per mitjanits locals;
  - esdeveniments dels calendaris activats de tots els comptes amb correu
    (el nucli ja omet els desactivats); no es mostren els cancel·lats
    ni els acabats; un d'en curs va a «Avui»;
  - un esdeveniment de tot el dia és una sèrie de dates desada a mitjanit
    UTC (`allDayLocalDays`), de manera que es col·loca per aquestes dates i
    no pels instants; acaba quan passa la seva última data. Als calendaris
    se'ls demana un dia més a cada costat per no perdre aquestes dates;
  - un esdeveniment de diversos dies apareix una vegada, en el seu primer dia
    dins de la finestra (a «Avui» si ja havia començat);
  - tasques obertes amb data de totes les llistes (no hi ha llistes
    desactivables); la data d'una tasca és un dia, mai una hora, de manera
    que una d'abans d'avui va primer, sota «Vençudes»; sense data o
    acabades no hi apareixen.
- **Ordre:** «Vençudes», després cada dia. Dins d'un dia: esdeveniments de
  tot el dia, esdeveniments per hora d'inici, i les tasques d'aquell dia per
  prioritat (alta primer) i títol.
- **Obrir:** un esdeveniment obre el calendari en visualització de dia, en
  la seva data (la de calendari per a un de tot el dia), amb l'esdeveniment
  obert a la seva fitxa (`openCalendarOn`, compartida amb les
  contrapropostes). Una tasca obre el seu editor sobre el que hi hagi a la
  pantalla; una tasca lligada a un missatge conserva la seva conversa.
- **Lectura:** des de la memòria cau, demanant al servidor que actualitzi
  per darrere, com la visualització de calendari. Es torna a llegir quan
  arriba `calendar.synced`, quan es tanca l'editor de tasques o canvia la
  llista de tasques, i just després de cada mitjanit local, perquè
  «Avui», «Demà» i «Vençudes» no es quedin enrere. Només compta la lectura
  més recent. Si un calendari o la llista de tasques no es pot llegir, es
  diu («pot estar incompleta»), mai no es mostra una setmana més curta
  com a completa. Si l'actualització del servidor d'un compte falla
  (`calendar.syncError`), el que s'ha desat es continua mostrant amb l'avís
  que pot estar desactualitzat, fins que un `calendar.synced` d'aquest
  compte cobreixi la setmana mostrada.
- **Teclat:** cada element és un botó natiu; els dies són regions amb
  nom (la seva capçalera).
- **Redimensionar:** un separador vertical comú (`PaneResizer`, rol
  `separator` amb `aria-valuenow`, `aria-valuemin`, `aria-valuemax`)
  per a la barra lateral, la llista de converses i la subfinestra de
  conversa del tauler:
  - punter: arrossegar, amb captura del punter, perquè passar per sobre
    del marc del lector no deixi l'arrossegament penjat; acaba en deixar
    anar, en cancel·lar-se o en perdre la captura. Teclat: fletxes (16 px, o
    2 % al tauler; amb Maj, quatre vegades més), Inici al mínim i Fi al
    màxim;
  - de dreta a esquerra (àrab): les posicions són lògiques (inici i
    final de la línia), i les fletxes i l'arrossegament segueixen la direcció
    en què es llegeix;
  - límits: barra lateral 280–560 px, llista 280–560 px, subfinestra del
    tauler 25–60 %; un valor desat fora de límits (o que no és un nombre)
    s'ajusta en llegir-lo;
  - el separador anuncia la mida dibuixada, no la desada: una llista estreta per la finestra diu la seva amplada real, i el seu màxim és
    aquesta amplada (créixer més no es veuria). Al tauler, la subfinestra no
    baixa mai de 320 px, de manera que el percentatge mínim puja amb una
    finestra estreta; si no queda marge (o a 600 px o menys, on ho ocupa tot),
    no hi ha separador;
  - la barra lateral va al costat del lector només si la finestra fa
    almenys 1100 px **i** la seva fila deixa al lector 360 px amb la barra a
    280 px; es mesura la fila, perquè la subfinestra de conversa del tauler
    pot ser estreta en una finestra ampla. Al costat del lector, el seu màxim
    és l'amplada que deixa al lector 360 px, i el separador anuncia aquest
    màxim. En els altres casos és una capa sobre el lector, amb l'amplada
    desada i com a màxim el 85 % de la finestra, sense separador;
  - les mides són preferències (`details_panel_width`,
    `thread_list_width`, `kanban_pane_width`) i es conserven entre
    reinicis.
- **Secció recordada:** l'última secció (resum, multimèdia, fitxers o
  agenda) es desa a `session_sidebar_section_main`. L'aplicació té
  una sola finestra, la principal; la clau porta el seu nom perquè una altra
  finestra, si se n'afegeix, tingui la seva. L'historial d'una persona no es
  recorda: necessita aquesta persona, que pot no ser a la conversa
  següent; es mostra damunt de la secció i es tanca en canviar de
  conversa. Canviar de conversa ja no torna al resum.
- **Capa sobre la capçalera:** com a capa, la barra lateral queda per sobre
  de la capçalera de la conversa. Abans quedava a sota i la seva pròpia
  capçalera (títol, Enrere, Tancar) no es veia.

## Alternatives descartades

- **Agenda visible en totes les visualitzacions, sense conversa oberta:**
  exigeix un altre contenidor en el disseny de l'aplicació (fora de l'abast
  de #212, que demana la barra lateral existent). És el que falta per a la
  paritat de la fila SET-23.
- **Finestra d'1 o 30 dies:** un dia no avisa de demà; trenta omplen la
  barra del que encara no importa. Set cobreixen la setmana que es planifica.
- **Barrejar tasques i esdeveniments només per hora:** la data d'una tasca no
  té hora; ordenar-la a mitjanit la posaria abans de tot el dia.
- **Repetir un esdeveniment de diversos dies en cada dia:** en una barra
  estreta multiplica les files; el calendari ja el mostra així.
- **Redimensionar també la capa estreta:** a 600–1024 px la capa ja
  ocupa gairebé tot el lector; arrossegar-la només podria tapar-lo més.
- **Una biblioteca de subfinestres:** l'arrossegament i el teclat són poc
  codi i no justifiquen una dependència nova.

## Proves

- `frontend/src/lib/agenda.test.ts`: ordre, filtres, dies, finestra, i
  esdeveniments de tot el dia en UTC, São Paulo i Sydney.
- `frontend/src/lib/paneResize.test.ts`: límits, mida dibuixada, quan
  va la barra al costat del lector, percentatges del tauler.
- `frontend/src/components/chat/SidebarAgenda.test.tsx`: contingut,
  ordre, obrir esdeveniments i tasques, focus, avís d'incompleta, relectures
  (sincronització, editor de tasques, mitjanit).
- `frontend/src/components/resizer/PaneResizer.test.tsx`: punter (també
  tornar a la mida de partida i passar del màxim), captura perduda,
  teclat, dreta a esquerra, límits.
- `frontend/src/components/chat/ConversationDetailsPanel.test.tsx`: secció
  recordada i restaurada, amplada desada i restaurada.
- `frontend/src/states/settings.test.ts`: mides desades ajustades.
- `frontend/e2e/startup.e2e.ts`: entrada de producció a 600, 1024 i 1440
  px, clar i fosc, text al 200 % i equivalent de zoom del 200 %
  (720 px a escala 2, a São Paulo i Sydney), Retorn sobre una tasca,
  límits a 600, 1100 i 1180 px amb 560 px desats, auditoria axe de la
  barra lateral i reinici.
