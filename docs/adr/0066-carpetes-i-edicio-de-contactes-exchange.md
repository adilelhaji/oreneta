# ADR-0066: Exchange (EWS): carpetes de contactes i edició de les persones

- Estat: acceptada pel propietari el 2026-10-17 («Sigue tus
  recomendaciones»): l'opció recomanada, una llibreta per carpeta de
  contactes d'Exchange i l'edició amb `ChangeKey` i `NeverOverwrite`, tal com
  és escrita aquí. Abans, el 2026-10-17, havia aprovat tancar les mancances
  de SET-19 com a part de completar l'aplicació d'escriptori (PR #264).
- Data: 2026-10-17.
- Abast: #257 (fila SET-19, #41). Sobre ADR-0012, ADR-0039, ADR-0052 i
  ADR-0058; per a Exchange, substitueix el punt 3 d'ADR-0012 i amplia el
  punt 3 d'ADR-0058. En queden fora els grups i els contactes de Microsoft
  Graph (#144), les bústies compartides o delegades més enllà de la del
  compte, les carpetes públiques, el mòbil i l'evidència amb un servidor real
  (N5) o nativa de Windows (N4).

## Context

ADR-0058 llegeix només la carpeta Contactes d'un compte d'Exchange. Les
persones hi són de només lectura i les llistes de distribució es llegeixen i
s'escriuen com a grups. ADR-0012 deixava les persones d'Exchange sense
edició fins a tenir evidència d'un servidor real. Faltaven dues coses: les
carpetes de contactes que hi ha sota Contactes, i l'edició de les persones. El
propietari ha demanat tancar-les.

Per decisió del propietari, la condició d'ADR-0012 (evidència d'un servidor
real abans d'editar) es relaxa: l'evidència real continua pendent (N5) i,
com per a les llistes, les proves es fan amb respostes SOAP enregistrades. El
risc acceptat és que un servidor real rebutgi o interpreti d'una altra manera
les escriptures de ranura o l'ordre de l'esquema. El limiten tres coses: cap
escriptura no sobreescriu un canvi remot (`NeverOverwrite`), només s'envia la
diferència i suprimir envia el contacte a Elements suprimits, d'on es pot recuperar.

## Decisió

### 1. Una llibreta per carpeta de contactes

- La llibreta del compte (`exchange-<compte>`) continua sent la carpeta
  Contactes. Quan es llegeix, es llisten les carpetes que té a sota, a
  qualsevol profunditat (`FindFolder` amb `Traversal="Deep"`), i cada una és
  una llibreta pròpia del compte: `exchange-<compte>/<id de carpeta>`, amb
  l'id de la carpeta a `url` i el nom «<compte> / <ruta>» (la ruta, amb `/`
  entre els noms).
- Només hi entren carpetes de contactes de debò: les de classe exactament
  `IPF.Contact` que no són amagades (`PR_ATTR_HIDDEN`) ni són dins d'una
  d'amagada. Les del sistema (`IPF.Contact.*`: Recipient Cache, GAL
  Contacts, Quick Contacts, Companies…) no es llisten.
- Una carpeta reanomenada o moguda dins de Contactes conserva la seva
  llibreta (l'id no canvia), que en pren el nom nou. Una carpeta que el
  llistat complet ja no porta (suprimida, o moguda fora de Contactes) se'n va
  amb les seves persones i les seves llistes. Un llistat que falla no treu
  res: una carpeta que no s'ha llistat no és una carpeta que ja no hi és. Una
  cadena de pares que torna sobre si mateixa es talla on es repeteix, com ja
  fa ADR-0058.
- Una carpeta que no es pot llegir conserva el que tenia i en diu el motiu.
  La llibreta del compte també ho diu i la lectura falla: una lectura
  incompleta no es pren mai per completa.
- Les llibretes de carpeta es llegeixen amb la del compte: l'actualització
  periòdica no les llegeix per separat (ni, per tant, quan la del compte està
  desactivada). «Torna-la a llegir ara» en una de carpeta llegeix només
  aquella.
- Arriben i se'n van amb la llibreta del compte. Eliminar-la les elimina
  totes; una de carpeta no es pot eliminar sola (la lectura següent la
  tornaria a portar), i la configuració no hi mostra el botó.
- No cal cap migració: la llibreta de Contactes conserva l'id i les dades, i
  l'esquema continua sent el 65.
- Les llistes d'una carpeta són els grups de la seva llibreta (ADR-0052,
  ADR-0058). Tot membre amb adreça porta el nom i l'adreça que va donar el
  servidor, de manera que un contacte d'una altra carpeta es mostra per la
  seva adreça. Un grup només pot rebre persones de la mateixa llibreta.

### 2. Editar les persones d'Exchange

- Les persones de totes les llibretes d'Exchange es poden crear (a la carpeta
  triada), editar i suprimir. «Desa a» ofereix la carpeta Contactes i les que
  té a sota.
- Amb la regla d'ADR-0012:
  - es llegeix el contacte del servidor; si la seva clau de canvis
    (`ChangeKey`) no és la que va llegir l'editor, no s'escriu res i es
    retorna la còpia del servidor, que queda desada aquí; si en editar-lo ja
    no hi és, és un conflicte i se'n va d'aquí;
  - l'escriptura porta la clau llegida i
    `ConflictResolution="NeverOverwrite"`; un rebuig del servidor
    (`ErrorIrresolvableConflict`, `ErrorStaleObject`, `ErrorItemNotFound`)
    també és un conflicte;
  - suprimir envia el contacte a Elements suprimits, després de comprovar la
    clau, perquè `DeleteItem` no la compara. Entre la comprovació i la
    supressió queda un instant que no es pot tancar; si un altre client canvia
    el contacte en aquell instant, el contacte es pot recuperar d'Elements
    suprimits. Un contacte que ja no és al servidor es dona per suprimit;
  - no s'escriu mai sense la clau llegida.
- Només s'envia el que ha canviat: el nom (`DisplayName`; «arxiva com a»,
  `FileAs`, el segueix només si era el nom que es mostrava o era buit), el nom
  de pila, el cognom, l'empresa, la nota (el cos, en text; els salts de línia
  `\r\n` i `\n` compten igual), les adreces i els telèfons. El que aquí no es
  veu (adreces postals, aniversari, càrrec, categories…) no es toca. Una nota
  canviada s'escriu com a text: un cos amb format HTML el perd.
- **Ranures.** Exchange guarda tres adreces (`EmailAddress1`–`3`) i els
  telèfons per tipus. Una adreça o un número que no canvien es queden on són;
  la ranura d'un que es treu es buida; un de nou va a una ranura lliure. Un
  telèfon nou (o que canvia de tipus) va primer a les ranures del seu tipus
  (mòbil, feina, casa, fax) i després a una de veu; un fax només va a les de
  fax. Un número sense tipus que ja no hi cap pot anar a una ranura de veu
  amb tipus, i aleshores es llegeix amb aquell tipus. Una ranura que guarda un
  identificador de directori continua ocupada, encara que aquí no es vegi.
  Una adreça nova s'escriu tal com es va escriure (sense `smtp:`) i es compara
  sense distingir majúscules i minúscules.
- **Un canvi que Exchange no pot guardar** falla abans d'enviar res, amb el
  motiu: una quarta adreça, un telèfon sense ranura lliure, una adreça que no
  és SMTP (sense part local o sense domini, amb un altre esquema com `sip:`, o amb
  espais) o un contacte sense nom ni adreça.
- **Crear sense duplicats.** L'editor dona a la persona nova un id que no
  canvia mentre és obert, i el contacte el porta com a propietat amb nom
  (`PublicStrings`, `OrenetaContactUid`). Abans de crear, se cerca aquest id a
  la carpeta: si un intent anterior ja va crear el contacte, s'adopta. Si la resposta
  a la creació es perd, se cerca de nou: si hi és, s'adopta; si no hi és, es
  diu que no hi és; si la cerca també falla, es diu que potser s'ha creat i que desar de
  nou no en farà un segon.
  - **Límit acceptat:** un editor nou és un id nou. Si es tanca l'editor
    després d'una fallada i se n'obre un altre per crear la mateixa persona sense
    tornar a llegir la llibreta, pot quedar un segon contacte.
- Després d'escriure es torna a llegir el contacte i es desa tal com ha
  quedat. Si aquesta lectura falla, l'error diu que el canvi s'ha desat a
  Exchange i que cal tornar a llegir la llibreta.
- La importació de vCard continua anant només a la llibreta local o a una de
  CardDAV.
- Temps d'espera de les crides des de l'escriptori: `people.save` i
  `people.delete`, 10 min, i `carddav.sync` i `exchange.contacts.sync`, 2 h,
  perquè una lectura dura el que dura la bústia (com l'exportació d'una
  carpeta): només s'atura una crida encallada. Cada petició EWS té un límit
  de 2 min al nucli, i la interfície no ha de deixar d'esperar mentre el nucli
  encara escriu. Els temps també valen per a CardDAV i la llibreta local.

### 3. Interfície

- La configuració mostra les llibretes de carpeta amb «Torna-la a llegir ara»
  i sense «Elimina». Eliminar la del compte avisa que també se'n van les
  carpetes (`contacts.removeExchangeMessage`). L'editor diu on es desa la
  persona, i la confirmació de suprimir una persona o una llista d'Exchange
  diu que se suprimeix al servidor.
- «Torna'l a crear» (una persona suprimida en un altre lloc mentre s'editava)
  la torna a crear a la llibreta on era, també a CardDAV; abans es creava a
  la llibreta local.

## Alternatives descartades

- **Totes les carpetes en una sola llibreta del compte:** és més simple, però
  no es pot triar on es crea un contacte ni es veu a quina carpeta és, i eM
  Client sí que ho mostra.
- **Llegir també les carpetes `IPF.Contact.*` del sistema:** omplirien la
  llibreta de gent que l'usuari no ha desat mai.
- **Eliminar les llibretes de carpeta una per una:** tornarien amb la lectura
  següent, si no es desés una llista de carpetes excloses (dades noves).
- **Escriure el contacte sencer o `ConflictResolution="AutoResolve"`:**
  sobreescriuria la feina d'un altre client (ADR-0012).
- **Crear sense id propi i acceptar un duplicat si es perd la resposta:**
  contradiu ADR-0039.

## Pendent

- Evidència amb un servidor Exchange real (N5) i nativa de Windows (N4): que
  el servidor accepta les escriptures de ranura i l'ordre de l'esquema tal
  com es descriuen, i que el llistat de carpetes deixa fora les del sistema.
- Grups i contactes de Microsoft Graph (#144).
- Bústies compartides o delegades i carpetes públiques; importar vCard a
  Exchange; adreces postals i els altres camps d'un contacte.

## Proves

Totes amb respostes SOAP enregistrades, sense servidor real:

- `exchange/book/tests.rs`: lectura de les ranures, la nota, «arxiva com a»
  i l'id nostre; carpetes (classe, amagades, bucle, ruta), llistat per
  pàgines que falla sencer o s'atura abans d'hora, lectura d'una carpeta per
  id; només la diferència, salts de línia de la nota, «arxiva com a» (també
  sense nom per mostrar), ranures d'adreça i de telèfon, canvi de tipus d'un
  telèfon, adreces escrites tal com es van escriure i les que no són SMTP,
  canvis que no hi caben, actualització amb la clau i conflictes, creació
  (ordre de l'esquema, resposta perduda o sense id, rebuig), cerca per l'id
  nostre i supressió (també d'un contacte que ja no hi és).
- `pim/exchange_book/tests.rs`: edició, edició sense la clau llegida, còpia
  local obsoleta, contacte suprimit al servidor, conflicte del servidor,
  error i resposta perduda, canvi que no hi cap, escriptura que no es pot
  tornar a llegir, creació en una carpeta, resposta perduda sense duplicat,
  segon intent amb l'id de l'editor, supressió (també d'un contacte que ja no
  hi és); llibretes de carpeta (crear-les, reanomenar-les, treure-les,
  llistat que falla, carpeta que falla, membres d'una altra carpeta),
  eliminar-les amb la del compte, eliminar una llibreta que no és d'Exchange
  i llistes creades en una carpeta.
- `app_helpers_test.go` (temps d'espera de les crides) i, a la interfície,
  `ExchangeContacts.test.tsx`.
