# ADR-0050: Carpetes preferides, colors i moure carpetes

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-07 de la paritat amb eM Client 10.4 (#87),
  «General → Carpetes». La navegació de carpetes per compte i crear una
  carpeta que entra a l'arbre abans de la sincronització següent ja
  hi eren; faltaven les preferides, els colors i arrossegar carpetes.

## Decisió

- **Preferides:**
  - qualsevol carpeta de qualsevol compte, l'arxiu local inclòs, es
    marca o desmarca des del seu menú contextual (clic dret, Maj+F10 o la
    tecla de menú);
  - una secció «Preferides» a dalt de tot a la navegació de correu les
    mostra en l'ordre que triï la persona, amb els seus no llegits i, si hi ha
    més d'un compte en joc, el nom del compte;
  - l'ordre es canvia arrossegant, amb Alt+↑/Alt+↓ (el focus es queda a
    la carpeta moguda i un avís `aria-live` en diu la nova posició) o amb
    «Pujar»/«Baixar» del menú;
  - es desen només aquí, com a preferència (`folder_favorites`), amb la
    clau compte + ruta de la carpeta al seu servidor; cap servidor no se
    n'assabenta.
- **Colors:**
  - una paleta fixa de nou colors amb nom (vermell, taronja, groc,
    verd, verd blavós, blau, morat, rosa, gris); el lector de pantalla
    diu el nom, mai un codi;
  - cada color té un to per al tema clar i un altre per al fosc, i
    tots mantenen almenys 3:1 contra les superfícies de la navegació
    (repòs, a sobre i actual), el mínim de WCAG 1.4.11 per a una marca
    que no és text; una prova ho comprova;
  - es veu com un punt al costat del nom i tenyeix la icona, a l'arbre i a
    Preferides; l'estil va en CSS per atribut (`data-folder-color`), sense
    estils en línia, de manera que serveix amb la CSP de producció;
  - preferència local (`folder_colors`), amb la mateixa clau que les
    preferides.
- **Què passa quan una carpeta canvia:**
  - moure una carpeta: el nucli retorna cada ruta que ha canviat (la carpeta
    i les seves subcarpetes) i preferides, colors, columnes de taulers i la
    visualització oberta segueixen la ruta nova;
  - suprimir una carpeta: la subcarpeta sencera que informa el nucli
    s'emporta les seves preferides i colors;
  - treure un compte: s'emporta les seves;
  - una carpeta que desapareix per un altre camí (suprimida o reanomenada en
    un altre client) deixa de ser a la llista del seu compte: la seva preferida i el seu
    color es treuen amb un avís visible («N carpetes preferides ja no
    existeixen i s'han tret»). Una llista buida o amb només la Safata
    d'entrada no compta, perquè és el que mostra un compte abans de la seva
    primera sincronització.
- **Moure carpetes:**
  - s'arrossega una carpeta sobre una altra del mateix compte, sobre una
    preferida d'aquest compte o sobre el títol «Carpetes» (nivell superior);
  - l'alternativa de teclat és «Moure carpeta a…» del menú, que obre un
    selector amb només les destinacions possibles i «Nivell superior»;
  - sempre es confirma, amb el nom de la carpeta i el de la destinació;
  - mai no es mouen Safata d'entrada, Enviats, Esborranys, Paperera,
    Correu brossa ni Arxiu (ni una carpeta que en tingui una a
    dins), ni una carpeta dins d'ella mateixa o d'una subcarpeta seva,
    ni a un altre compte, ni on ja és, ni damunt d'una carpeta amb el
    mateix nom. La interfície no accepta aquestes destinacions i diu per què; el
    nucli ho torna a comprovar tot sobre la seva pròpia llista;
  - moure és reanomenar la ruta jeràrquica: `Trabajo` sobre `Proyectos`
    passa a `Proyectos/Trabajo` amb el delimitador que anunciï el servidor
    (`.` en servidors tipus `INBOX.`). Un servidor sense delimitador no
    té jerarquia i es rebutja; l'arxiu local i POP3 fan servir `/`.
- **Nucli (`folders.move`, `meron_core::folder_move`):**
  - planifica sobre la llista desada: comprova les regles i calcula els
    noms nous de la carpeta i de tota la seva subcarpeta;
  - IMAP: un `RENAME` (RFC 3501 6.3.5 també mou les inferiors), després de
    treure la sessió reutilitzada de la bústia amb `EXAMINE INBOX`, com en
    suprimir; mai no es repeteix, perquè si es perd la resposta el resultat
    és incert i la sincronització de carpetes següent diu la veritat;
  - arxiu local i POP3: es reanomenen les seves files (`archive_messages`), que
    són el seu servidor;
  - després es concilia la memòria cau en una transacció: carpetes (amb el seu
    delimitador), missatges, estat de sincronització i ids d'Exchange
    passen a la ruta nova; els resultats de cerca desats de les
    rutes velles es descarten. Els UID es conserven: si el servidor ha canviat
    UIDVALIDITY amb el reanomenament, la sincronització següent ho veu i
    torna a portar la carpeta, com amb qualsevol altre canvi;
  - respon amb la carpeta nova, la llista de reanomenades i les carpetes,
    perquè el pont i la interfície no hagin d'endevinar.
- **Microsoft Graph i Exchange (EWS):** aquest nucli encara no gestiona
  carpetes en cap dels dos (tampoc crear ni suprimir), de manera que moure
  queda desactivat amb el motiu a la vista («Moure carpetes encara no està
  disponible en aquest compte») i el nucli ho rebutja igualment; a Graph
  a més ho atura la protecció de només lectura.
- **Pont:** `mail.folderMove` a Go valida la petició, crida
  `folders.move` (30 s de marge, com suprimir) i dona forma a les carpetes.

## Alternatives descartades

- **Desar preferides i colors al servidor (anotacions IMAP METADATA
  o categories d'Exchange):** pocs servidors ho admeten i cadascun a la seva
  manera; eM Client també ho desa en local.
- **Triar qualsevol color (selector lliure):** no es pot garantir el
  contrast en els dos temes ni donar un nom que llegeixi el lector de
  pantalla.
- **Esborrar la memòria cau de la carpeta moguda i tornar-la a baixar:** més
  senzill, però obliga a baixar una altra vegada tot el correu de la carpeta i
  les seves subcarpetes per un canvi de nom.
- **Moure amb `CREATE` + `COPY` + `DELETE`:** no és atòmic, duplica el
  correu si es talla a mitges i perd els UID; `RENAME` és l'operació
  del protocol per a això.
- **Implementar ja `MoveFolder` d'EWS i `move` de Graph:** cap dels
  dos adaptadors no gestiona carpetes encara i els seus ids de carpeta no són
  rutes; fer-ho bé és feina de la seva pròpia decisió.

## Pendent (#87 continua oberta)

- Moure carpetes a Exchange i a Microsoft Graph: fet. Exchange amb EWS
  `MoveFolder` (ADR-0058, #211); Microsoft Graph a ADR-0057 (#210).
- Deixar anar missatges sobre una carpeta o una preferida de la navegació: avui
  no existeix arrossegar missatges a la navegació (només entre columnes del
  tauler i fonts RSS); quan existeixi, una preferida ho ha d'acceptar igual
  que la seva carpeta.
- Regles de correu per a tots els comptes la destinació de les quals és una carpeta
  moguda: continuen apuntant a la ruta vella. Les del mateix compte ja la
  segueixen (ADR-0058).
- Evidència nativa a Windows i de proveïdors reals (la fila exigeix
  `requiresNative`).
