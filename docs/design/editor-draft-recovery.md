# Recuperació d'esborranys de l'editor (#170)

Connecta l'editor complet al magatzem local de #169
([contracte del magatzem](local-draft-storage.md)). Codi:
`frontend/src/states/localDraftSync.ts`, enganxat a `states/compose.ts`, amb
l'estat visible a `components/composer/LocalDraftStatus.tsx`.

## Problema

Les pestanyes de l'editor es copiaven a localStorage només com a text: els
adjunts es treien perquè els seus bytes no caben a la quota. Després d'un
reinici, l'esborrany tornava sense cap fitxer adjunt i sense avís que en
faltaven.

## Contracte

- **Què es desa.** Cada pestanya de redacció es desa sencera al magatzem local:
  compte, remitent, destinataris, assumpte, tots dos cossos, opcions de
  protecció i cada adjunt amb els seus bytes i la seva mida exacta.
  L'identificador local és el de la pestanya. La còpia de text a localStorage
  continua igual, com a reserva quan el magatzem no es pot llegir.
- **Quan.** Després d'una pausa de 600 ms sense canvis, i immediatament en
  tancar l'aplicació (`beforeunload` i `pagehide`). Les escriptures d'un mateix
  esborrany van en cua, mai alhora. Un canvi que no altera el document no
  s'escriu.
- **Revisió.** Cada escriptura indica la revisió que el magatzem va confirmar
  l'última vegada. Si el magatzem en té una altra de més recent, o l'esborrany
  s'ha descartat en un altre lloc, no se sobreescriu res. El desament automàtic
  s'atura i el redactor ho indica. Davant d'una còpia més recent, «Conserva
  aquesta versió» escriu el que es veu, partint de la revisió vigent. Davant
  d'un descart, el text continua a la pantalla per enviar-lo o copiar-lo. La
  làpida (tombstone) no se sobreescriu mai.
- **Tancar la pestanya.** Enviar, descartar o tancar conservant l'esborrany del
  servidor esborren la còpia local. L'esborrat espera l'escriptura en curs i
  deixa una làpida. Així una escriptura tardana no pot ressuscitar un esborrany
  ja enviat o descartat. Si no s'havia arribat a desar res de la pestanya, no
  s'esborra res. Reobrir un enviament desfet crea una pestanya amb un altre
  identificador.
- **Arrencada.** Fins que no es llegeixen els esborranys desats no se n'escriu
  cap, perquè encara no se'n coneix la revisió de partida. La lectura es
  reintenta amb una espera creixent mentre el nucli s'inicia. Després:
  - un esborrany desat substitueix la còpia de text de la mateixa pestanya i
    torna amb els seus adjunts;
  - un que només és al magatzem s'obre com a pestanya;
  - una pestanya que només tenia localStorage s'escriu al magatzem, i aquesta
    n'és la migració;
  - una pestanya tancada abans d'acabar la lectura s'esborra aleshores, sense
    reaparèixer;
  - un esborrany il·legible s'informa com a error i no es converteix mai en un
    de buit.
  Les pestanyes obertes es llegeixen després de l'última espera, de manera que
  una pestanya oberta mentrestant no es perd.
- **Imatges inserides.** El cos amb format apunta a fitxers `/media/<clau>` i
  els seus bytes també són entre els adjunts desats. La neteja de fitxers
  orfes en arrencar es fa ara després de llegir el magatzem. Abans es feia
  només amb les pestanyes de localStorage, i hauria esborrat les imatges d'un
  esborrany que només fos al magatzem. Si el magatzem no es pot llegir, no es
  neteja res.
- **Errors visibles.** «S'està desant una còpia en aquest equip…» i «Còpia
  desada en aquest equip» es mostren de manera discreta. Un error d'escriptura,
  per exemple un límit superat o el disc ple, es mostra amb el motiu del nucli,
  i el canvi següent ho torna a intentar.

## Proves

- `localDraftSync.test.ts` fa servir un magatzem fals amb les regles de revisió
  i de làpida del nucli. Cobreix els bytes exactes de base64, cap escriptura
  abans de la lectura, el document complet amb adjunts i revisions
  encadenades, l'escriptura omesa si no canvia res i la pausa d'escriptura.
  També cobreix el bolcatge en tancar, el conflicte amb «conserva aquesta
  versió», el descart en un altre lloc i l'error amb reintent. Prova l'esborrat
  després d'una escriptura en curs sense ressurrecció, l'escriptura pendent
  anul·lada en tancar, la recuperació amb adjunts i la revisió de partida, i la
  migració des de localStorage. Comprova la pestanya tancada abans de la
  lectura, l'esborrany il·legible, l'error de llistat i la pestanya oberta
  durant la lectura.
- `LocalDraftStatus.test.tsx` fa servir l'estat real de `compose$`. Comprova que
  obrir, escriure i tancar desa i esborra, que la neteja d'imatges espera la
  lectura del magatzem i que l'arrencada sense nucli es rendeix sense escriure.
  També prova el text de cada estat i el botó «Conserva aquesta versió».
- L'arrencada de producció (Playwright) respon a `localDrafts.*` i continua
  sense ordres inesperades.
- El magatzem mateix, amb concurrència, límits, corrupció i reversió
  (rollback), està provat en Rust per #169.

## Límits que continuen oberts

- **Resposta ràpida.** El quadre de resposta del fil encara no fa servir aquest
  magatzem. El seu text sobreviu com abans, sense adjunts després de reiniciar.
- **Fitxers multimèdia perduts.** Si el fitxer `/media/<clau>` d'una imatge
  inserida desapareix, per exemple en restaurar el perfil en un altre equip,
  l'editor la mostra trencada. Els seus bytes continuen als adjunts desats, però
  el cos no indica a quin correspon. Resoldre-ho requereix desar aquesta
  correspondència en inserir la imatge.
- **Finestra de pèrdua.** Un tancament brusc, com una fallada elèctrica o la mort
  del procés, pot perdre fins a 600 ms d'escriptura al magatzem. La còpia de
  text de localStorage els cobreix, però sense els adjunts afegits en aquest
  interval.
- **Flux natiu.** «Escriure, tancar l'aplicació i tornar-la a obrir» al binari de
  Windows (N4) encara no s'ha executat aquí. El reinici se simula a les proves.
