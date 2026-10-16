# Estructura del correu: defectes verificats i corregits (iteració 5)

Revisió de l'estructura (shell) del correu amb el codi de la branca, amb data del
2026-10-10. Cada defecte es va reproduir abans amb una prova que fallava i es va
corregir en un commit propi. No substitueix les proves natives ni les captures de
referència que demana la iteració.

## Corregits

| Issue | Defecte | Correcció | Prova |
|---|---|---|---|
| #34 | Una fallada en arxivar, moure o esborrar en bloc desfeia també el que el servidor ja havia fet. Marcar com a llegit i destacar anaven en paral·lel sobre una llista que tots modificaven. | Totes les accions en bloc van d'una en una. Una fallada desfà només aquella conversa i s'informa «n de m fetes, després s'ha aturat: motiu». | `mail.test.ts` |
| #35 | En imprimir es treia la política que bloqueja les imatges remotes, el marc compartia l'origen sense `sandbox` i faltaven els missatges antics sense avís. | CSP pròpia a la impressió, píxels de seguiment eliminats, marc amb `sandbox` sense scripts i avís quan falten missatges. | `print.test.ts`, `printDocument.test.ts`, `bubbleHtml.test.ts` |
| #30 | Les visualitzacions filtrades no oferien «carrega'n més» encara que hi hagués més pàgines. | `canLoadMoreThreads` ho decideix per cursor i visualització. | `listPaging.test.ts` |
| #36 | La capçalera de la taula marcava la columna triada en visualitzacions que el nucli no ordena així: cerca, destacats, visualització unificada amb un canal. | Es marca l'ordre aplicat: la columna triada a les pàgines per conversa i «més recent primer» a la resta, amb un avís. | `ThreadTable.test.tsx`, `useThreadListLoader.test.tsx` |
| #36 | La visualització de posposats d'un compte va per hora de tornada, però en conservar la conversa oberta es reordenava la pàgina per data. | La conversa conservada torna a la seva posició sense reordenar. La taula no marca cap columna en aquesta visualització i la llista no agrupa per data. | `mailPaging.test.ts`, `ThreadTable.test.tsx` |
| #36 | Una amplada de llista desada de 560 px deixava el lector a 149 px amb 769 px i a 185 px amb 1025 px. | La llista cedeix fins a 280 px i el lector en conserva almenys 360. En pantalles amples es manté l'amplada desada. | e2e de producció a 769, 1024, 1025 i 1440 px |
| #36 | Una versió 1.5 de les visualitzacions de bústia es llegia com a format antic i el canvi següent la sobreescrivia. | Qualsevol versió més gran que 1 es tracta com a posterior i no es modifica. | `mailboxViews.test.ts` |
| #33 | El text secundari d'un tema personalitzat sense editar quedava a 3,43:1 sobre el fons i a 2,94:1 sobre una fila seleccionada. | S'aclareix només fins on manté 4,5:1. L'editor avisa, amb la proporció, quan els colors triats no ho permeten. | `themes.test.ts`, `ThemeEditorDialog.test.tsx` |
| #87 | Una carpeta creada des d'Oreneta no tenia delimitador fins a la sincronització següent. Les seves subcarpetes no es tenien en compte en esborrar-la. | Pren el delimitador de les altres carpetes del compte. | `store::tests::a_folder_created_here_takes_the_account_delimiter_into_the_tree` |

## Decisions que no s'han pres aquí

- **Ordre de la resta de fonts.** L'ordre per remitent o assumpte a la cerca,
  els destacats, els posposats i la visualització unificada amb canals continua
  sense contracte (ADR-0003). La interfície ja no promet aquest ordre.
  Implementar-lo és una decisió del nucli, no un arranjament de la interfície.
- **Temes desats.** Un tema personalitzat desat conserva els seus colors
  fins que s'edita i es torna a desar. Canviar-lo en carregar-lo seria una
  migració de preferències, que #33 demana que sigui explícita i reversible.

## Pendent de la iteració

- **N2.** Captures de referència en clar i en fosc comparades a cada
  amplada (599/600/601, 768/769, 1024/1025, 1440 i zoom al 200 %). Les proves
  d'amplada existeixen; les captures comparades, no.
- **N3.** Ordre estable entre pàgines amb arribades concurrents, amb maddy.
- **N4.** El flux de lectura i organització a l'aplicació nativa.
- **#87.** Preferits, colors de carpeta, arrossegament segur i desfer verificat
  continuen sense proves completes.
