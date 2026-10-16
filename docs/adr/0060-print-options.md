# ADR-0060: Opcions d'impressió

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #213); pendent de revisió del propietari al final del pla.
- Data: 2026-10-15.
- Abast: #213, fila SET-05 del llibre de paritat («General → Imprimir»
  d'eM Client 10.4), sobre la impressió de #35. Les garanties de #35 no
  canvien: el contingut remot continua bloquejat i el que en queda fora es diu.
  Disseny: [docs/design/printing.md](../design/printing.md).

## Decisió

- **Un grup de Paràmetres, no un quadre de diàleg en imprimir:** «Imprimir» a
  Paràmetres → General, amb el mateix patró que «Respostes i reenviaments»
  (ADR-0047). Imprimir continua sent un clic i l'elecció es recorda sense
  passos de més.
- **Una sola preferència, una sola fila:** `settings$.print`, desada a la
  fila `print_options` de `settings` com un objecte. En llegir-la, cada camp
  desconegut o invàlid torna al seu valor per defecte per separat
  (`sanitizePrintOptions`).
- **Les opcions i els seus valors per defecte** (els d'abans, perquè ningú no
  vegi canviar la seva impressió perquè ha aparegut un paràmetre):
  - camps de capçalera: assumpte com a títol de la pàgina, data, Per a i CC
    activats; CCO desactivat;
  - abast: la conversa sencera (per defecte) o un missatge;
  - ordre, només per a la conversa: del més antic al més recent (per
    defecte) o a l'inrevés;
  - llista d'adjunts per nom: activada.
- **El remitent s'imprimeix sempre:** en paper no hi ha cap altra manera de
  saber qui va escriure cada missatge. A Paràmetres es mostra com a
  «S'imprimeix sempre», no com un interruptor.
- **CCO desactivat per defecte:** només existeix a les còpies enviades i
  anomena persones de les quals els altres destinataris no sabien res; va
  al paper només si es demana.
- **CCO activat es recorda, i s'avisa:** com les altres opcions, queda
  activat fins que es desactiva. Risc acceptat: qui el deixa activat i
  després imprimeix una conversa per a una altra persona li revela els
  destinataris ocults. L'ajuda del paràmetre ho diu («continua activat fins
  que el desactivis»). Es prefereix a desactivar-lo automàticament després
  de cada impressió perquè la incidència demana que les eleccions es recordin i un
  paràmetre que canvia pel seu compte sorprèn; el valor per defecte continua
  sent desactivat.
- **Què és «aquest missatge»:**
  - des del menú d'un missatge («Imprimir missatge…», nou), aquest missatge,
    sigui quin sigui l'abast recordat; les altres opcions s'apliquen;
  - des del menú de la conversa amb l'abast «Un missatge», el missatge
    més recent dels carregats que no sigui un esborrany (carpeta
    d'esborranys) ni una còpia local sense enviar (a la finestra de desfer o
    pendent de reintent). És el missatge al qual el lector porta la vista
    (el més antic queda a dalt) i el que la visualització tradicional obre
    desplegat. Si tots els carregats són esborranys o còpies sense
    enviar, s'imprimeix el més recent d'aquests, marcat;
  - un esborrany o una còpia sense enviar que s'imprimeix (en la conversa
    sencera o demanat amb «Imprimir missatge…») porta en el paper la marca
    «Esborrany» o «No enviat», traduïda: el paper no els pot fer passar
    per correu que ha sortit;
  - un missatge s'imprimeix amb el seu propi assumpte (pot ser el d'una
    resposta).
- **Ordre per data, no per ordre de càrrega,** amb ordre estable: dos missatges
  del mateix segon conserven l'ordre en què van arribar. «El més recent
  primer» és exactament aquest ordre a l'inrevés, empats inclosos.
- **El títol de la pàgina (`<title>`) es manté** encara que es tregui
  l'assumpte: és el títol de la finestra i el nom del PDF o del treball
  d'impressió. L'ajuda del paràmetre de l'assumpte ho diu.
- **El que en queda fora es diu** (#35), a dalt, abans del primer missatge:
  - conversa: l'avís de missatges antics no carregats, com abans;
  - un missatge: «Només s'imprimeix aquest missatge de la conversa…» quan la
    conversa en té d'altres, carregats o encara al servidor;
  - un missatge la conversa del qual no està carregada aquí: no se sap si en
    té d'altres, de manera que es diu sense afirmar-ho: «Només s'imprimeix
    aquest missatge; els altres missatges de la conversa, si n'hi ha, no.»;
    una conversa carregada i completa d'un sol missatge no porta avís;
  - no s'avisa del que la persona ha triat treure (capçaleres, adjunts).
- **Sense conversa carregada no s'imprimeix res:** abans que acabi la
  càrrega, o si falla, no hi ha missatges; una pàgina buida passaria per una
  impressió. S'avisa amb un missatge d'error («Aquesta conversa encara no
  s'ha carregat…») i no s'obre el quadre de diàleg d'impressió. La pàgina no
  afirma mai «només s'imprimeix aquest missatge» si no n'imprimeix cap.
- **Contingut remot:** la política CSP pròpia de la pàgina, la retirada de
  píxels de seguiment i el marc sense scripts no depenen de cap
  opció; les proves ho comproven amb totes les combinacions.

## Alternatives descartades

- **Quadre de diàleg d'opcions a cada impressió:** un pas més cada vegada per
  a una elecció que gairebé no canvia mai, i un patró de quadre de diàleg
  nou; el quadre de diàleg del sistema ja permet triar pàgines i impressora.
- **Una fila per opció:** vuit files noves a `settings` per a un grup que
  es llegeix sempre junt.
- **Remitent com a opció:** una impressió sense remitent no diu qui va
  escriure què.
- **«Aquest missatge» des de la capçalera com el missatge visible o
  enfocat:** el lector no té avui un missatge seleccionat; inventar-lo
  canviaria la visualització de conversa, fora d'aquest abast.
- **«Aquest missatge» com el més recent rebut, sense esborranys ni enviaments
  propis:** en una conversa l'última paraula de la qual és una resposta
  pròpia imprimiria un missatge anterior al que es veu desplegat; s'exclouen
  només els esborranys i les còpies sense enviar, que no són correu que ha
  sortit.
- **Desactivar CCO després de cada impressió:** més prudent davant de la
  revelació, però contradiu que les eleccions es recordin i canvia un
  paràmetre sense que la persona el toqui; s'accepta el risc amb l'avís a
  l'ajuda.
- **Avisar també de les capçaleres o els adjunts trets:** és una elecció de
  qui imprimeix, no una omissió oculta.

## Pendent

- Prova nativa d'impressió a Windows (execució N4 final): SET-05 no passa
  a «verified» sense ella.
- Previsualització d'impressió pròpia i opcions de pàgina (marges, fons).
