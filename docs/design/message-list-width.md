# Amplada i files de la llista de missatges (#283)

[#283](https://github.com/adilelhaji/oreneta/issues/283) és la peça 2 de la
proposta de redisseny que el propietari va aprovar el 2026-10-17 («Lo apruebo»);
les decisions d'aquella aprovació estan registrades a
[#288](https://github.com/adilelhaji/oreneta/issues/288). La comparació nativa del
2026-10-17, amb la finestra maximitzada, mostrava el remitent i l'assumpte tallats
a pocs caràcters. La captura (no versionada) mostrava una llista d'uns 276 px
dibuixada com la taula de columnes per defecte de #84, que repartia aquella amplada
entre la casella, el remitent, l'assumpte i la data.

## Decisió

- **Amplada per defecte:** passa de 350 a 360 px (`THREAD_LIST_DEFAULT_WIDTH`,
  `frontend/src/lib/paneResize.ts`) per a un perfil que no ha redimensionat mai
  la llista. Els límits no canvien (280–560 px, ADR-0059) i l'amplada
  redimensionada continua sent la preferència `thread_list_width` del perfil,
  conservada entre reinicis.
- **Vista automàtica:** la preferència `list_view` admet un tercer valor,
  `auto`, que és el valor per defecte dels perfils que no n'han desat cap. Mostra
  files mentre la llista dibuixada fa menys de 520 px (`AUTO_TABLE_MIN_WIDTH`,
  `frontend/src/components/threads/listView.ts`) i la taula a partir d'aquesta
  amplada. Segueix l'amplada dibuixada, no la desada: una llista ampla que la
  finestra estreny passa a files. Mentre la llista no s'ha mesurat, decideix
  l'amplada desada.
- **Configuració:** a Configuració > General, Vista de la llista ofereix
  «Automàtica» al costat de «Targetes» i «Taula»; triar-la desa `auto`.
- **Files de dues línies:** a la vista automàtica estreta, la densitat
  «Compacta» fa dues línies d'uns 56 px: remitent i data a la primera, assumpte i
  previsualització a la segona, amb avatar de 32 px. Les densitats «Còmoda» i
  «Àmplia» ja tenien dues línies o més i no canvien. Les files s'agrupen per data
  quan la llista està ordenada per data (no en una cerca ni a Destacats), com ja
  feien les targetes. La fila oberta ho diu amb `aria-current`, com la taula.
- **Eleccions explícites:** un `list_view` desat (`cards` o `table`) es respecta
  a qualsevol amplada. No es reescriu cap preferència desada.
- **Contrast:** el text secundari de les files (previsualització, data i
  recomptes) passa a ple, sense opacitat, i la fila oberta fa servir `bg-active`,
  com la taula; el text secundari translúcid no arribava al contrast AA de 4,5:1.
  Les targetes del tauler (kanban) comparteixen aquestes files, i també hi
  canvien els colors, no la disposició.
- **Mesura:** la llista només es mesura a la vista automàtica, i el component
  només es torna a dibuixar quan l'amplada travessa els 520 px; mentre la llista
  està amagada (en una finestra estreta, amb la conversa oberta) decideix
  l'amplada desada.

## Fora d'abast

- L'ordre en què cedeixen les subfinestres en una finestra estreta no canvia: el
  lector conserva 360 px i la llista cedeix fins a 280 px (ADR-0059). A
  1280 px o més, amb l'amplada per defecte, no cedeix cap de les dues.
- Un perfil que ja té desada una amplada estreta la conserva; a la vista
  automàtica la veu amb files de dues línies.
- Un perfil que va triar explícitament la taula la conserva a qualsevol
  amplada, també a 280 px.
- Ordenar per remitent o per assumpte continua fent-se des de les capçaleres de
  la taula; les files no tenen cap control d'ordenació (com ja passava amb les
  targetes). Amb un ordre que no és per data, les files no s'agrupen.
- En actualitzar, un perfil sense `list_view` desat passa de la taula a la vista
  automàtica, i de 350 a 360 px si no havia redimensionat la llista. Una versió
  anterior que llegeixi `auto` no el reconeix i mostra el seu valor per defecte
  (la taula) sense reescriure res.

## Verificació

- Proves unitàries: resolució de la vista i llindar (`listView.test.ts`),
  densitats (`listDensity.test.ts`), valors per defecte, hidratació i guarda de
  tipus (`settings.test.ts`), i representació de la llista
  (`frontend/baseline/autoListView.test.tsx`: files i grups per data a 360 px,
  cap grup en una cerca, taula a 560 px, eleccions explícites).
- Proves sintètiques del punt d'entrada de producció
  (`frontend/e2e/startup.e2e.ts`):
  - a 1280, 1456 i 1920 px, en català, anglès i àrab, en clar i en fosc: llista de
    360 px, files de dues línies amb grups per data, remitent i assumpte sencers,
    lector de 360 px o més, cap desbordament i cap infracció axe greu ni crítica
    (axe comprova la llista en repòs, sense cap fila oberta ni seleccionada);
  - redimensionar la llista amb el teclat i recarregar: l'amplada es conserva, i
    la vista automàtica canvia a taula a 560 px i torna a files a 296 px;
  - una llista desada de 560 px que s'estreny en una finestra de 1024 px passa a files
    (segueix l'amplada dibuixada);
  - obrir, respondre, seleccionar i navegar sobre les files per
    defecte, en clar i en fosc;
  - triar «Automatic» a la configuració desa `auto`.
- L'evidència nativa de Windows continua pendent.
