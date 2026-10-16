# Plantilles i previsualitzacions fiables (#40)

## Fallades reproduïdes

- **Plantilla de text com a HTML.** Una plantilla desada només com a text
  s'inseria a l'editor de text enriquit tal qual, com a marcatge. `a < b` trencava
  el cos, `<b>` posava negreta i els salts de línia es perdien. Passava tant a la
  plantilla de missatge com al fragment inserit al cursor. Un test
  existent fixava aquest comportament.
- **Plantilla HTML a l'editor de text.** Les etiquetes es treien amb una
  expressió regular, de manera que `&amp;` arribava literalment i els paràgrafs
  s'ajuntaven.
- **PDF de tornada a la pàgina 1.** L'efecte de canvi de pàgina ignorava la
  pàgina 1. En passar de la 2 a la 1, el llenç continuava mostrant la 2 sota el
  rètol «1 de N».
- **PDF reobert a cada renderització.** El diàleg passava un `onFailed` nou a
  cada renderització, i aquesta funció era una dependència de l'obertura, de manera que
  qualsevol nova renderització tancava el document, el reobria i tornava el
  lector a la pàgina 1.

## Contracte

- **Text pla a l'editor de text enriquit.** S'escapa (`&`, `<`, `>`, `"`).
  Les línies en blanc separen paràgrafs i un salt simple és `<br>`
  (`plainTextToHtml`). Una plantilla amb HTML s'insereix com a HTML.
- **HTML a l'editor de text.** Es llegeix amb el mateix `htmlToText` de la resta de
  l'aplicació, amb les entitats descodificades i els paràgrafs separats.
- **Previsualització de PDF.**
  - **En canviar de fitxer.** El document s'obre una vegada per fitxer i
    torna a la pàgina 1. Una càrrega que es resol tard no pinta sobre el
    fitxer nou; aquesta protecció ja existia i continua provada.
  - **En passar pàgina.** Cada pàgina, inclosa la 1, es dibuixa al document
    ja obert.
  - **En tancar.** Tancar el diàleg destrueix la tasca de càrrega i el seu worker.
- **Error i baixada.** El diàleg diu «Aquest tipus de fitxer no es pot
  mostrar aquí» o «No s'ha pogut llegir aquest adjunt», i «Desa» és sempre al
  peu. El diàleg es torna a muntar per a cada adjunt, de manera que un error no
  passa d'un fitxer al següent.

## Proves

- `applyTemplate.test.ts`: escapament i paràgrafs d'una plantilla de text en mode
  enriquit, fragment escapat, plantilla HTML intacta i HTML a text amb
  entitats. Es va corregir el test que fixava la fallada.
- `PdfPreview.test.tsx`: tornar a la pàgina 1 la redibuixa; una nova
  renderització amb una funció de retorn nova no reobre ni canvia de pàgina; cinc
  cicles d'obrir i tancar destrueixen cinc documents; s'informa d'un document que
  no s'obre. Els dos primers fallaven abans del canvi.

## Límits

- La mesura de la memòria retinguda en cicles repetits (criteri 4 de #40)
  necessita el mètode acordat al dispositiu de referència (N6). Aquí només
  es prova que cada cicle allibera el seu document i el seu worker.
- No s'ha provat amb PDF mal formats reals. El camí d'error es prova amb un
  `getDocument` que falla: s'informa i s'allibera la tasca.
- Filtrar els adjunts per nom, tipus o mida queda per a més endavant.
