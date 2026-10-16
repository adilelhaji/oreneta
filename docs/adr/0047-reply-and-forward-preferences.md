# ADR-0047: Preferències de resposta i reenviament

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-09 de la paritat amb eM Client 10.4 (#39), «Correu →
  Respostes i reenviaments». Els destinataris de respondre i respondre a
  tots i la identitat (àlies) ja estaven resolts i provats; faltaven el
  format de la citació, la capçalera de la resposta i el mode de reenviament.
  La documentació d'eM Client no era accessible des de l'entorn de
  treball, de manera que se segueix el conjunt comú dels clients d'escriptori
  (eM Client, Outlook, Thunderbird).

## Decisió

- **Una sola preferència, una sola fila:** `settings$.replyForward`, que es
  desa a la fila `reply_forward` de `settings` com un objecte. En llegir-la,
  cada camp desconegut o invàlid torna al seu valor per defecte per
  separat (`sanitizeReplyForwardPrefs`), de manera que una fila escrita per una
  versió més nova no fa perdre les altres eleccions.
- **Les opcions i els seus valors per defecte:**
  - incloure el missatge original a les respostes: sí;
  - on s'escriu la resposta: damunt de la citació (per defecte) o a sota
    (resposta al peu);
  - com se cita: bloc HTML (`blockquote` amb vora esquerra, el que ja
    posa `inlineRichStyles` en enviar) o text pla amb «> » davant de
    cada línia; una línia que ja comença per «>» en rep un altre «>» i els
    nivells s'apilen com a «>> »;
  - capçalera: curta («El {data}, {nom} va escriure:») o el bloc
    d'Outlook (De / Enviat / Per a / CC / Assumpte, sense les files buides);
  - escurçar els prefixos repetits de l'assumpte: sí («Re: RE: Aw: Re[2]:»
    passa a «Re:»; «Fwd: FW:» a «Fwd:»; un «Re:» dins d'un reenviament es
    conserva); desactivat, es manté el comportament anterior (s'afegeix
    «Re: » tret que l'assumpte ja comenci per «Re:»);
  - reenviar: en línia (per defecte) o com a adjunt `.eml`;
  - en un reenviament en línia, copiar els adjunts de l'original: sí (el que ja
    feia l'aplicació).
- **On s'aplica la citació:** a la resposta oberta a l'editor
  complet (`openReplyInFullEditor`). La resposta ràpida del fil és una
  conversa: l'original ja és a la pantalla a sobre, de manera que no se cita,
  però sí que fa servir l'assumpte escurçat. Si la preferència deixa fora l'original,
  la resposta s'obre exactament com abans.
- **HTML o text:** un original HTML es respon en HTML; si no, una
  resposta sense res escrit segueix el format del compte, com un missatge
  nou, i el text portat de la resposta ràpida conserva la seva forma plana.
  Amb la citació en text pla la resposta és sempre de text pla.
- **La signatura va amb el que escriu la persona, no després de la citació:**
  - resposta damunt de la citació i sense res escrit: se sembra com un
    reenviament (citació al cos, signatura amb la marca `aboveQuote`), perquè
    canviar de compte canviï la signatura al seu lloc i no n'afegeixi una altra sota la
    citació;
  - en els altres casos `openComposeTab` col·loca la signatura després del text propi
    i després uneix la citació davant o darrere (`joinReplyBody`).
- **Dates, noms i escapaments:**
  - la data s'escriu amb `Intl.DateTimeFormat` en l'idioma de l'aplicació
    (`dateStyle: medium`, `timeStyle: short`) i la zona del sistema; les
    proves fixen la zona;
  - les frases i etiquetes passen per `t()` amb `defaultValue`;
  - noms, adreces i assumptes s'escapen en HTML;
  - un valor amb escriptura de dreta a esquerra s'aïlla amb FSI…PDI
    (U+2068/U+2069) perquè la frase no es desordeni; els altres valors no
    porten marques invisibles.
- **Reenviar com a adjunt:**
  - el pont Go afegeix `mail.rawMessage`, que reutilitza `messages.saveRaw`
    del nucli (el mateix camí que «Desar com a .eml») cap a un fitxer
    temporal privat, el llegeix, l'esborra i retorna els bytes en base64 amb un
    nom de fitxer sanejat; els bytes no travessen el protocol JSON
    limitat del nucli;
  - límit de 50 MB: un original més gran no passaria els límits dels
    proveïdors un cop codificat;
  - l'esborrany s'obre amb l'assumpte «Fwd:» i el cos buit (amb signatura),
    i l'original s'afegeix com a `message/rfc822`;
  - si no es pot portar (sense connexió, sense motor), l'esborrany continua
    obert i un avís d'error ho diu; mai no s'envia sense l'original en
    silenci;
  - un missatge que només existeix aquí (un enviament optimista que encara no ha tornat
    del servidor) no té original per adjuntar i es reenvia en línia;
  - en construir el MIME (`smtp::build_message`), un adjunt
    `message/rfc822` net en 7 bits s'escriu tal qual amb
    `Content-Transfer-Encoding: 7bit`, com demana RFC 2046 §5.2.1; un que no
    ho és (8 bits, línies de més de 998 caràcters, salts solts) continua en
    base64, perquè l'aplicació envia només en 7 bits i els lectors obren tots dos.

## Alternatives descartades

- **Una fila per opció:** set files noves a `settings` i set branques
  d'hidratació per a un grup que es llegeix sempre junt.
- **Citar també a la resposta ràpida:** el fil ja mostra l'original i
  cada bombolla enviada el repetiria; a més, la bombolla optimista i
  l'esborrany compartit haurien de distingir el text propi del citat.
- **Portar l'original al navegador pel protocol del nucli:** les seves
  respostes tenen una mida de línia limitada; escriure a un fitxer temporal
  ja existeix i no la té.
- **Base64 per a tot `message/rfc822`:** funciona a la pràctica, però RFC
  2046 ho prohibeix i alguns lectors estrictes no obren l'adjunt com a
  missatge.

## Pendent

- Prova nativa (Windows) i de proveïdor del reenviament com a adjunt: SET-09
  continua «partial» fins que la incidència propietària enumeri l'evidència.
- Reenviar diversos missatges alhora com a adjunts.
- Respondre amb la selecció citada (només el text marcat).
- Plantilles de capçalera editables per la persona.
