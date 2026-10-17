# Amplada i files de la llista de missatges (#283)

Peça 2 de la proposta de redisseny aprovada pel propietari el 2026-10-17
(«Lo apruebo»). Una prova nativa amb la finestra maximitzada mostrava la llista a
280 px, amb el remitent i l'assumpte tallats a pocs caràcters, perquè la taula de
columnes repartia aquella amplada entre remitent, assumpte i data.

## Decisió

- **Amplada per defecte:** 360 px (`THREAD_LIST_DEFAULT_WIDTH`,
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
- **Files de dues línies:** a la vista automàtica estreta, la densitat
  «Compacta» fa dues línies d'uns 56 px: remitent i data a la primera, assumpte i
  previsualització a la segona, amb avatar de 32 px. Les densitats «Còmoda» i
  «Àmplia» ja tenien dues línies o més i no canvien. Les files s'agrupen per data
  quan la llista està ordenada per data, com ja feien les targetes.
- **Eleccions explícites:** un `list_view` desat (`cards` o `table`) es respecta
  a qualsevol amplada. No es reescriu cap preferència desada.
- **Contrast:** les files fan servir els tokens del tema sense opacitat (text
  secundari ple; fila oberta amb `bg-active`, com la taula), perquè el text
  secundari translúcid no arribava al contrast AA de 4,5:1.

## Fora d'abast

- L'ordre en què cedeixen les subfinestres en una finestra estreta no canvia: el
  lector conserva 360 px i la llista cedeix fins a 280 px (ADR-0059). A
  1280 px o més, amb l'amplada per defecte, no cedeix cap de les dues.
- Un perfil que ja té desada una amplada estreta la conserva; a la vista
  automàtica la veu amb files de dues línies.

## Verificació

Proves unitàries de la resolució de la vista, de les densitats, dels valors per
defecte i de la hidratació, i de la representació de la llista
(`frontend/baseline/autoListView.test.tsx`). Proves del punt d'entrada de
producció (`frontend/e2e/startup.e2e.ts`) a 1280, 1456 i 1920 px, en català,
anglès i àrab, en clar i en fosc: llista de 360 px, files de dues línies amb grups
per data, remitent i assumpte sencers, lector de 360 px o més, cap desbordament i
cap infracció axe greu ni crítica. Una altra prova redimensiona la llista amb el
teclat, recarrega i comprova que l'amplada es conserva i que la vista automàtica
canvia a taula a 560 px i torna a files a 296 px. Són proves sintètiques del
navegador; l'evidència nativa de Windows continua pendent.
