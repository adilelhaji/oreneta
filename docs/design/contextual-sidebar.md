# Barra lateral contextual (#86)

El tauler de detalls d'una conversa (multimèdia, fitxers i participants) afegeix
«Historial amb …» per a cada participant.

- **Què mostra:** les converses amb aquella adreça, les reunions properes en què
  és (organitzador o assistent) i els fitxers que ha enviat. Cada element obre
  el seu origen: la conversa, el dia al calendari o el missatge del fitxer.
- **Aïllament:** només el compte de la conversa oberta. Un altre compte que
  tingui correu de la mateixa persona no hi apareix, i una resposta lenta per al
  compte anterior no es pinta al nou.
- **Adreça completa:** `ana@x.test` no coincideix amb `diana@x.test`. La
  consulta filtra per subcadena i després es comprova l'adreça exacta.
- **El que hi ha aquí:** s'indica de quants missatges desats surt i quants
  tenen el cos baixat, perquè l'historial antic pot faltar.
- **Nucli:** `meron-core/src/person_context.rs`, RPC `context.person`.

## Proves

- **Nucli:**
  - una conversa per fil, la més recent primer;
  - sense la Diana i sense un altre compte;
  - reunions futures, sense les passades ni les cancel·lades.
- **Aplicació:**
  - cada element obre el seu origen;
  - avís d'historial parcial;
  - una resposta tardana d'un altre compte no hi apareix.

## Agenda, amplada i secció recordada (#212, ADR-0059)

- **Agenda:** secció de la barra amb els esdeveniments dels calendaris activats
  i les tasques amb data dels pròxims 7 dies; les tasques vençudes, primer. Els
  esdeveniments de dia sencer van per la seva data, no per l'hora UTC en què es
  desen. Cada element obre l'esdeveniment (el calendari al seu dia) o la tasca
  (el seu editor). Si una font no es llegeix, ho diu; si el servidor d'un
  compte no s'actualitza, avisa que pot estar desactualitzada fins que una
  sincronització de la setmana ho aconsegueixi. Es rellegeix en sincronitzar,
  en tancar l'editor de tasques i a mitjanit.
- **Límit:** a l'agenda només s'hi arriba des de la barra lateral d'una conversa
  oberta. No hi ha cap tauler de ginys independent (en arrencar sense conversa,
  ni a Calendari, Tasques, Contactes o Notes); per això la fila SET-23 continua
  `partial`.
- **Amplada:** al costat del lector (finestra ≥ 1100 px i fila amb espai per a
  280 px més 360 px de lector) s'arrossega o es mou amb el teclat entre 280 i
  560 px, sense deixar el lector per sota de 360 px; es desa entre reinicis.
  Altrament és una capa sobre el lector, per damunt de la seva capçalera, de com
  a màxim el 85 % de la finestra. La llista de converses i el tauler del
  kanban fan servir el mateix separador, que indica la mida dibuixada i segueix
  la direcció de lectura.
- **Secció:** es torna a obrir a l'última que s'ha fet servir (resum,
  multimèdia, fitxers o agenda), també després de reiniciar. L'historial d'una
  persona no es recorda. Si és oberta o tancada es recorda com abans, només
  durant la sessió.
- **Proves:** `lib/agenda.test.ts`, `lib/paneResize.test.ts`,
  `SidebarAgenda.test.tsx`, `PaneResizer.test.tsx`,
  `ConversationDetailsPanel.test.tsx` i l'entrada de producció (600, 1024,
  1100, 1180 i 1440 px, mode clar i fosc, 200 %).
