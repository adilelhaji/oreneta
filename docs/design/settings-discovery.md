# Descoberta de la configuració i de les ordres (#163 / #149)

## Inventari i abast

Abans d'aquest canvi, la paleta ja oferia ordres de redacció, sincronització,
cerca i filtre, conversa, compte i carpeta, tauler, tema i configuració. Les
seves etiquetes i sinònims eren literals en anglès. La seva compactació, només
ASCII, tractava una consulta com `日本語` com a buida i retornava totes les
ordres. La configuració tenia una pàgina general, navegació per comptes, taulers
i calendaris, i controls existents amb el seu propi estat; no tenia cerca a la
configuració ni destinacions de focus directes.

Aquest lliurament fa servir aquestes accions i editors. Ara la paleta té etiquetes
i sinònims en anglès i en castellà, distingeix **Opció de configuració** d'**Acció**,
i pot saltar a l'aparença, la tipografia, la lectura, la signatura global, la
privadesa de l'assistent, la còpia de seguretat de la configuració, els controls
d'actualització admesos i la configuració o les signatures exactes d'un compte.
Els comptes de canals no anuncien cap signatura. Les actualitzacions només
s'anuncien quan l'amfitrió n'informa la compatibilitat. Privadesa vol dir els
controls de privadesa de l'assistent existents, no un centre de privadesa nou per
a tot.

Els altres idiomes conserven l'anglès com a alternativa per a les entrades noves
del catàleg. Els noms de compte, carpeta, tauler i tema que dona l'usuari
es mantenen intactes. Els àlies en anglès continuen sent cercables en castellà.
No s'introdueix cap motor d'ordres, model de persistència, capacitat de proveïdor
ni enviament automàtic de correu nous.

## Comportament

- La cerca unifica majúscules i minúscules, accents i formes de compatibilitat
  d'Unicode, però conserva les lletres d'escriptures no llatines. Una entrada en
  blanc ho llista tot; una consulta no buida que es redueix a cap caràcter
  cercable no esdevé mai un comodí. La coincidència existent per subcadena i
  subseqüència continua disponible per als caràcters reals. Les etiquetes i els
  àlies literals precedeixen les coincidències aproximades, amb un ordre estable
  en cas d'empat.
- Totes dues cerques exposen un quadre combinat amb nom i una opció activa,
  navegació amb fletxes, activació amb Retorn, selecció visible i resultats
  buits. Les opcions seleccionades es desplacen fins a fer-se visibles; les
  etiquetes i les indicacions llargues s'ajusten. El focus de Tab segueix l'opció
  real; confirmar una composició d'IME no activa un resultat abans d'hora.
- La cerca de la configuració navega a seccions existents ja muntades. Escriure
  una consulta no desmunta els editors ni en duplica l'estat. El retard
  (debounce) existent de les signatures i el buidatge en desmuntar continuen sent
  la referència. Triar un compte canvia el context de la configuració sense canviar
  la bústia que s'està llegint; els comptes eliminats s'ignoren.
- En tancar-se, la paleta restableix el seu obridor connectat i disponible abans
  que una ordre obri una altra superfície. La configuració reutilitza el cicle de
  vida compartit del focus dels diàlegs. Retornar el focus no implica un
  confinament complet del focus ni una certificació nativa amb lectors de pantalla.
- Les ordres d'escriptura de Graph mostren la seva restricció existent de només
  lectura i continuen inertes; l'execució torna a comprovar la capacitat actual
  del compte. Les proteccions existents de l'estat i del backend es mantenen. La
  redacció d'un missatge nou continua disponible si algun compte pot enviar, i fa
  servir la selecció de remitent existent; es desactiva quan no en pot enviar cap.
  La descoberta no concedeix mai cap permís.
- En pantalles estretes, la configuració apila la navegació sobre el contingut en
  lloc de reservar una barra lateral fixa que deixa l'editor massa estret per fer-lo
  servir. Els valors de les preferències es queden als magatzems existents i
  només els canvien els seus controls existents.

## Límit de les proves

Les proves unitàries cobreixen els límits d'accents i d'Unicode, els canvis
d'idioma en directe i l'alternativa, la destinació exacta i l'eliminació de
comptes, la disponibilitat de les capacitats de canals i d'actualització, les
ordres de només lectura, els resultats buits i el retorn del focus. Les proves
dels diàlegs compartits conserven la cobertura de StrictMode, l'autofocus,
l'eliminació de l'obridor i Esc mentre està ocupat després d'extreure'n el hook
de cicle de vida per reutilitzar-lo. Les regressions de la revisió cobreixen
l'activació amb Tab, la confirmació d'IME, la redacció amb Graph i IMAP barrejats i
els canvis de capacitat abans de l'execució.

Les proves sobre el punt d'entrada de producció fan servir el pont sintètic
existent: anglès i castellà, clar i fosc, 600/1440px, teclat, zoom CSS del 200%,
preservació de la signatura a través de la cerca, la navegació i la recàrrega,
context del compte i comportament de Graph sense escriptura. L'acceptació més
àmplia, nativa i de localització completa, de #149/#37 continua oberta. Aquest
lliurament no inclou cap executable, instal·lador, versió publicada, alta de
compte ni experiment amb correu real.

Comprovacions locals: la comprovació de tipus, la validació del catàleg i la
compilació van passar; van passar 930 proves unitàries i de components i dues
comprovacions de l'empaquetador. L'execució inicial completa de navegador va
passar 71 casos del punt d'entrada de producció i 63 de la base; els set casos de
descoberta van tornar a passar després de les correccions de la revisió (la
bateria de producció ara en conté 72). La CI del commit exacte continua sent la
porta d'integració. Es mantenen els avisos de compilació existents sobre la mida
dels fragments. Aquest tram no tradueix completament els controls interns de
l'assistent.
