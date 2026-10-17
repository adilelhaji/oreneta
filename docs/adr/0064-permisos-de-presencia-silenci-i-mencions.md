# ADR-0064: Qui pot veure l'estat, silenciar una conversa i mencions sense llegir (XMPP)

- Estat: acceptada per delegació (el propietari va aprovar el 2026-10-17 tancar
  els buits de la fila SET-21 per completar l'aplicació d'escriptori); pendent
  de revisió del propietari al final del pla.
- Data: 2026-10-17.
- Abast: #256, filla de #111 (fila SET-21 del registre d'acceptació, «Xat →
  General» d'eM Client 10.4). Tanca tres dels quatre punts que l'ADR-0055 va
  deixar pendents. El quart, l'absència automàtica per inactivitat, necessita
  una API nova del sistema i és la proposta de l'ADR-0065.

## Decisió

- **Qui pot veure l'estat propi:**
  - surt de la llista de contactes del servidor (roster, RFC 6121): hi
    consten les adreces amb subscripció `from` o `both`. El nucli la demana a
    cada sessió nova, abans d'anunciar l'estat (RFC 6121 §2.2);
  - es desa només en memòria, per a la sessió, com la resta de la presència
    (ADR-0055); com a màxim 5000 adreces, i si el servidor en dona més la
    visualització ho diu («Només es mostren els primers 5000»);
  - fins que el servidor respon, la llista és **desconeguda** (`null`) i la
    visualització ho diu; mai no es mostra com a «ningú». Si el servidor no
    respon o respon amb un error, es queda desconeguda;
  - els canvis arriben com a avisos del roster (roster push, RFC 6121
    §2.1.6). Només es prenen els del servidor propi (sense adreça o amb
    l'adreça nua del compte); els d'un altre dispositiu o d'una altra persona
    no es prenen. Cada avís vàlid es contesta amb un resultat buit, com
    demana la RFC; les altres preguntes (iq) continuen sense resposta, com
    abans;
  - **deixar de compartir** l'estat amb algú envia `unsubscribed` (RFC 6121
    §3.2), la mateixa resposta que «Rebutja» una petició
    (`chat.answerSubscription` amb `allow: false`): no cal cap mètode nou. Només
    surt en prémer i després de confirmar-ho. La llista canvia quan el servidor
    ho diu (amb l'avís del roster), no abans; mentrestant la visualització
    mostra «S'està deixant de compartir…»;
  - per tornar-lo a veure, aquella persona l'ha de tornar a demanar, i la
    persona decideix (ADR-0055).
- **Silenciar una conversa:**
  - una conversa directa, un privat (`grup/sobrenom`) o un grup es poden
    silenciar des de la seva capçalera (un botó de commutació amb el seu estat,
    `aria-pressed`), i la llista ho indica;
  - silenciada, no genera cap notificació del sistema, **ni tan sols les
    mencions**: és el que ha demanat la persona. El que arriba es desa i compta
    com a no llegit igualment, i el comptador de mencions continua comptant;
  - ho decideix el nucli, a `should_notify` (paràmetre `muted`), on ja es
    decideixen la resta d'avisos;
  - es desa per compte en una fila de configuració, `chat_mute:<compte>` (una
    llista JSON), sense taules ni columnes noves, com l'estat propi de
    l'ADR-0055. La conversa es desa com la desa el nucli
    (`normalize_conversation`): l'adreça en minúscules i el sobrenom tal com és;
  - com a màxim 1000 converses per compte: silenciar-ne una més es rebutja
    amb un missatge i no se'n descarta cap en silenci. Un element malmès de la
    fila (que no és text o és buit) s'ignora sense tocar la resta;
  - en treure el compte se suprimeix la fila; en sortir d'un grup se n'oblida
    el silenci, i els seus privats, que es queden (ADR-0055), conserven el seu;
  - si la fila no es pot llegir, l'avís surt igualment: perdre un missatge és
    pitjor que una notificació no volguda;
  - RPC nou `chat.mute` (`account`, `conversation`, `muted`), que torna la
    llista; `chat.conversations` i `chat.rooms` porten `muted`. És un canvi
    additiu del contracte.
- **Mencions sense llegir:**
  - cada grup de la llista porta `unread_mentions`: els missatges d'altres,
    sense llegir, que mencionen la persona amb la mateixa regla que el
    ressaltat (ADR-0055) i amb el sobrenom que hi té ara. Es calcula en llistar
    els grups, sense columna nova;
  - com a màxim es miren els 2000 missatges sense llegir més nous de cada grup.
    Si n'hi ha més, `mentions_capped` ho diu i la visualització mostra el nombre
    com a mínim («@N+», «N o més»), també quan és zero: mai no es presenta com a
    exacte;
  - la visualització mostra el nombre de cada grup a la llista i el total del
    compte a la capçalera, amb un text per als lectors de pantalla;
  - com amb el ressaltat, una menció feta només per referència XEP-0372, sense
    el sobrenom al text, no es compta (avisa en arribar, ADR-0055).

## Alternatives descartades

- **Recordar només els permisos donats en aquesta sessió (sense roster):** no
  mostra els que es van donar abans ni des d'un altre dispositiu. L'ADR-0055 va
  descartar el roster perquè per al que feia llavors no calia; per gestionar
  els permisos és l'única font.
- **Desar el roster al magatzem:** en tornar seria antic, i la presència ja es
  desa només per a la sessió (ADR-0055).
- **Treure de la llista en prémer, sense esperar el servidor:** la llista
  diria una cosa que el servidor potser no ha fet.
- **Un mètode `chat.revoke` propi:** `unsubscribed` és la mateixa resposta que
  rebutjar una petició; un segon camí faria el mateix.
- **Deixar passar les mencions d'una conversa silenciada:** és el que fan
  alguns serveis, però la persona ha demanat silenci; les mencions es veuen
  igualment al comptador.
- **Silenciar fins a una hora:** no el demana la fila; es pot afegir després
  sense canviar el que es desa ara (una llista).
- **Una columna `mention` a `chat_messages` per comptar sense llegir el
  text:** és una migració d'esquema, i la menció es calcula en llegir des de
  l'ADR-0055.
- **Comptar tots els missatges sense llegir, sense límit:** un grup gran sense
  obrir durant mesos alentiria cada actualització de la llista.

## Conseqüències

- SET-21 es manté `partial`: falten l'absència per inactivitat (ADR-0065) i
  l'evidència nativa de Windows (N4).
- Les proves són unitàries i deterministes (stanzas enregistrades, magatzem en
  memòria i proves de la visualització); no s'afegeix cap prova contra Prosody.
