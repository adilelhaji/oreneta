# ADR-0056: Recordatoris després d'una suspensió i d'un canvi de zona horària

- Estat: acceptada per delegació (el propietari va delegar les decisions de
  disseny de #209 i #225 en l'opció més prudent); pendent de revisió
  del propietari al final del pla. El punt que va quedar «a confirmar» (els
  avisos d'esdeveniments acabats) el va decidir el propietari: es mostren
  (#225, vegeu «Ampliació del 2026-10-16: avisos perduts»). Només queda «a
  confirmar» el que encara s'aparta d'aquesta decisió: el mòbil no els mostra.
- Data: 2026-10-15; ampliada el 2026-10-16 (#225).
- Abast: #209 i #225 (fila SET-29 del registre d'acceptació, pare #100), sobre els
  recordatoris comuns d'ADR-0045 (`pim::reminders`). Disseny:
  [recordatoris del calendari](../design/calendar-reminders.md).

## Context

Un recordatori es donava una vegada, tornava a donar-se si l'esdeveniment es
movia i sobrevivia a un reinici. Però:

- només es donava si l'esdeveniment encara no havia començat. Si l'equip
  dormia a l'hora de l'avís i es despertava amb la reunió ja començada, es
  perdia, i un avís «en començar» (0 minuts) no es donava mai;
- el vigilant de l'escriptori mirava cada minut amb un temporitzador del
  rellotge monotònic, que en alguns sistemes s'atura durant la suspensió;
- l'avís d'un esdeveniment de dia sencer comptava enrere des de la
  mitjanit UTC de la seva data, no des de la mitjanit local: a Madrid, «el
  dia abans a les 18:00» sonava a les 20:00, i no seguia el lector a una altra zona;
- la notificació de Go mostrava l'hora en la zona amb què havia arrencat
  l'aplicació, i un avís donat tard semblava un avís a temps.

## Decisió

- **Cada mirada queda anotada per compte** (`meta`,
  `reminders.look:<cuenta>`): quan va ser i el desfasament UTC de la zona en
  aquell moment. S'escriu després d'anotar els avisos donats; un tall entre
  tots dos només fa mirar una altra vegada el mateix buit, i el que s'ha
  anotat impedeix repetir. S'esborra amb el compte (ADR-0011).
- **Què dona una mirada**: cada avís no anotat l'hora del qual ha arribat,
  una sola vegada:
  - el seu esdeveniment encara no ha començat (a temps, o sincronitzat tard), o
  - no havia vençut en la mirada anterior: va vèncer mentre ningú no mirava
    (equip adormit, aplicació tancada) o un canvi de zona el va avançar. Si
    el seu esdeveniment continua, es dona sol; si ja ha acabat, és un avís perdut.
- **Un avís l'esdeveniment del qual va acabar abans de mirar** no es donava
  (#209); des de #225 es dona en un únic avís agrupat d'avisos perduts, per
  decisió del propietari (vegeu «Ampliació del 2026-10-16: avisos perduts»).
- **Un avís «en començar»** (0 minuts) es dona en la primera mirada des de
  l'inici, mentre l'esdeveniment continua: abans no es donava mai
  (correcció). Un esdeveniment sense durada compta com a en curs durant el
  seu primer minut, de manera que el seu avís «en començar» el dona la
  mirada d'aquell minut.
- **Límits del buit**: un rellotge endarrerit no obre buit (la mirada anterior
  compta com a «ara»); un buit es mira com a molt 14 dies enrere, i
  el registre d'avisos donats en guarda cadascun fins a 16 dies després de
  l'inici del seu esdeveniment (#222, vegeu «Ampliació del 2026-10-16:
  registre d'avisos donats»). Sense mirada anterior (primera vegada, o
  després d'actualitzar) només es dona el que encara no ha començat, com abans.
- **Si el magatzem falla** en cercar el que ha vençut o en anotar un avís,
  aquest avís no es dona i la mirada no s'anota: la següent torna a mirar el
  mateix buit i el dona llavors, una vegada.
- **Comptes en pausa o silenciats**: no s'avisa i la seva mirada avança igual.
  El que venç mentrestant no es dona després com a perdut; un avís vençut
  durant la pausa l'esdeveniment del qual encara no ha començat sí que es
  dona en reprendre, per la regla de sempre.
- **En despertar**: `system.resumed` fa mirar a l'acte, sense esperar el
  minut següent. L'hora és sempre la del rellotge de paret; el temporitzador
  ja no acumula ticks perduts (`MissedTickBehavior::Delay`).
- **Zones, segons el model del calendari**:
  - esdeveniment amb hora (amb zona o en UTC): un instant; el seu avís no es mou;
  - esdeveniment de dia sencer: una data (desada com la seva mitjanit UTC);
    l'avís compta des de la mitjanit local en la zona de l'equip en cada
    mirada. Un dia sense mitjanit (canvi d'hora a les 00:00) comença quan
    comença el rellotge;
  - hora flotant (CalDAV, subscripcions): es llegeix en la zona de l'equip en
    llegir el calendari (`subscription`). Després d'un canvi de zona s'anota
    (`reminders.reread:<cuenta>`) que cal rellegir els comptes amb
    calendaris CalDAV o subscrits visibles; l'escriptori demana aquesta lectura
    a l'acte i de nou cada 15 minuts, amb la mateixa finestra (així no se'n
    llancen dues alhora), fins que cadascun d'aquests calendaris s'ha llegit
    després del canvi. Un compte silenciat es rellegeix igual; un en pausa,
    en reprendre'l. L'avís segueix aquesta lectura com el d'un esdeveniment mogut.
- **Canvi de zona**: es detecta comparant el desfasament que la zona actual
  dona a l'instant de la mirada anterior amb el que es va anotar. Un canvi
  d'horari d'estiu no compta: la mateixa zona dona el mateix desfasament al
  mateix instant. Sense canvi de zona, quan vencia un avís en la mirada
  anterior es calcula amb la zona actual (amb les seves regles d'horari
  d'estiu); amb canvi, amb el desfasament anotat, que és tot el que se sap de
  la zona anterior.
- **Què diu l'avís**: cada `calendar.reminder` porta, a més del de
  sempre, `local_time` («HH:MM» de l'inici en la zona actual; `null` en un
  dia sencer), `started` (si l'esdeveniment ja havia començat) i `local_date`
  («AAAA-MM-DD» si no és avui; `null` si ho és). Go mostra la data davant
  de l'hora quan no és avui i, si ja ha començat, «Va començar a les {time}»
  (`notify.reminderStarted`, traduït). Sense aquests camps fa servir el seu
  propi rellotge com abans.
- **Mòbil**: `take_due` deixa fora la llista de relectures; el mòbil rellegeix
  els seus calendaris en el refresc de cada 15 minuts (ADR-0045), que és també
  el que esborra la relectura pendent. A Android, `chrono::Local` podria
  donar UTC si el sistema no li diu la zona; queda per a la prova nativa.

## Ampliació del 2026-10-16: registre d'avisos donats (#222)

Decisió per delegació del propietari (l'opció més prudent).

- **Problema**: el registre d'avisos donats s'esborrava 14 dies després de
  donar-se cada avís. Un avís posat més de 14 dies abans del seu esdeveniment
  (Google permet quatre setmanes; un VALARM, qualsevol termini) s'esborrava
  amb l'esdeveniment encara per endavant i es donava una altra vegada.
- **Ara** cada registre es guarda fins que l'inici de l'esdeveniment pel
  qual es va donar (la clau `<evento>@<inicio>`) queda més de 16 dies enrere
  (`GIVEN_KEPT`: els 14 dies que es mira enrere més 2 de marge de
  zona horària, pels esdeveniments de dia sencer), i també el moment en
  què es va donar. Passat això cap mirada no el pot tornar a donar: ni és per
  endavant ni ha vençut dins del buit que es mira.
- **Limitat**: tot registre acaba esborrat; la taula només guarda avisos
  d'esdeveniments per endavant o dels últims 16 dies. Un registre anterior al
  fet que la clau portés l'inici (només l'identificador) s'esborra 16 dies
  després de donar-se (abans, 14).
- Sense migració d'esquema: l'inici es llegeix de la clau, després de l'última
  `@` (els identificadors de CalDAV en poden portar una). Com que un
  identificador antic també pot acabar en `@<número>`
  (`reunion@2000000000`), la clau només compta com a `<evento>@<inicio>` si
  aquest esdeveniment està desat amb aquest inici (revisió de Codex); si no,
  s'esborra com abans, 16 dies després de donar-se. Així una clau antiga no
  es guarda anys per un número que sembla un inici (silenciant aquest
  esdeveniment), i la d'un esdeveniment mogut o suprimit, que ja no serveix,
  tampoc.
- Això es basa en el fet que un avís mai no sona després de l'inici del seu
  esdeveniment. Els lectors només guarden avisos anteriors a l'inici; per si
  el magatzem tingués un termini negatiu, es tracta com a «en començar».

## Conseqüències

- Després de dormir durant l'avís d'una reunió encara en curs, l'avís arriba en
  despertar, una vegada, dient que ja ha començat.
- Els avisos de dia sencer canvien d'hora respecte d'abans: sonen abans
  a l'est d'UTC (Europa, Àsia) i després a l'oest (Amèrica), ara a l'hora
  local que es va demanar.
- Un esdeveniment flotant l'avís del qual ja s'ha donat i que, per anar cap a
  l'oest, queda més tard, s'avisa una altra vegada abans de la nova hora (com
  un esdeveniment mogut).
- Si la nova lectura d'un esdeveniment flotant el situa en un moment ja
  començat, el seu avís no es dona tard (com un esdeveniment mogut al passat).
  Fins a aquesta lectura, sense connexió, l'esdeveniment flotant conserva
  l'instant anterior.
- No hi ha migració d'esquema ni canvi en el model `Event`. Hi ha un text
  nou (`notify.reminderStarted`) en els 19 idiomes.

## Alternatives descartades

- **Desar l'hora de paret dels esdeveniments flotants en una columna nova**
  (esborrany #198): exacte abans de rellegir, però exigeix migració d'esquema
  i tocar la construcció d'`Event` en tots els proveïdors, per a un cas rar
  (CalDAV gairebé sempre escriu `TZID`). Rellegir ja és el que defineix el model.
- **Agrupar els avisos perduts en un avís nou i comptar els d'esdeveniments
  acabats** (esborrany #198): descartada a #209 perquè afegia esdeveniments,
  textos i interfície; adoptada a #225 quan el propietari va decidir veure'ls.
- **Donar també els avisos d'esdeveniments acabats, un per un**: després
  d'una nit adormit arribaria una ràfega d'avisos inútils.
- **Recordar la mirada anterior només en memòria**: no cobreix l'aplicació
  tancada ni el mòbil, que mira en processos separats.
- **Demanar la relectura una sola vegada**: l'escriptori no rellegeix els seus
  calendaris pel seu compte (ADR-0045); una lectura fallida deixaria l'hora
  flotant en la zona anterior fins que algú obrís el calendari.
- **Detectar el canvi de zona pel seu nom IANA**: no sempre està
  disponible i no dona la zona anterior per a calcular; el desfasament sí.

## Ampliació del 2026-10-16: avisos perduts (#225)

El propietari va decidir que els avisos d'esdeveniments que van acabar mentre
ningú no mirava es mostrin, com a eM Client i Outlook, sense ràfega. La resta
la va decidir la delegació, amb l'opció més prudent.

- **Què és un avís perdut**: un de no anotat que va vèncer després de la mirada
  anterior (la mateixa regla i el mateix límit de 14 dies que més amunt) i
  l'esdeveniment del qual ja ha acabat en el moment de mirar. Sense mirada
  anterior no hi ha perduts: no se sap quin buit hi va haver. Una reunió
  rebutjada (Exchange «decline», Google «declined») no es compta com a perduda.
- **Un sol avís**: tots els perduts encara no mostrats, de tots els
  comptes, van en un únic esdeveniment `calendar.missedReminders`: `count`
  (quants en total), `keys` (el compte i la clau `<evento>@<inicio>` de
  cadascun), els 20 més recents com a `calendar.reminder` a `reminders`
  (cadascun amb la seva `key` i `at`), del més recent al més antic (la reunió
  perduda més recent és la que més probablement encara demana alguna cosa, i
  no ha de quedar darrere els «…»), i els dies que abasten en la zona actual:
  `day` (el més recent) i `first_day`. «Més recent» és per `at`, quan comença
  l'esdeveniment en la zona actual: un dia sencer comença a la seva mitjanit
  local, no a la mitjanit UTC que guarda `start`; Go ordena igual en ajuntar.
- **La notificació** (Go): el títol diu quants (`notify.missedReminders`)
  i el cos, un per línia, quan i què, fins a 5 i «…» si n'hi ha més. El
  títol és neutre, «N avisos perduts», i no «mentre l'equip dormia»:
  el buit també pot venir de tenir l'aplicació tancada. En idiomes
  amb més formes de plural que «un/altre» (polonès, àrab, letó) diu el
  número sense plural («Pominięte przypomnienia: N»), perquè Go només tria
  entre aquestes dues. Els assumptes són text d'altres (invitacions): cadascun
  ocupa una línia (sense salts ni caràcters de control, fins a 80
  caràcters) i es mostra com a text, mai com a marcatge; igual l'assumpte
  i el lloc d'un avís solt.
- **En prémer-la** s'obre el calendari en el dia més recent amb avisos
  perduts: en visualització de dia si tots són d'aquell dia i, si abasten més
  dies, en visualització de setmana d'aquell dia, que mostra els altres al
  voltant (`calendar:AAAA-MM-DD` o `calendar:week:AAAA-MM-DD` com a destinació
  del clic).
- **No es descarta mai**: el nucli ja els ha anotat com a donats, així que Go
  guarda l'avís (i hi suma els que arribin mentrestant, una vegada cada clau)
  mentre no el pot mostrar, i el mostra tan aviat com pot:
  - en arrencar, fins que la interfície li ha dit l'idioma i el pla de
    silenci, o 30 segons com a molt: la primera mirada arriba abans, i sense
    esperar sortiria en anglès, sense respectar el silenci ni sonar;
  - durant les hores de silenci que retenen els avisos, fins que acaben
    (al final de l'interval, o amb el pla que treu una pausa indefinida).
  Sona quan es mostra (`calendar.missedRemindersShown`), no en arribar.
- **Ni si l'aplicació es tanca abans de mostrar-lo** (revisió de #225):
  la memòria de Go no n'hi ha prou. El nucli guarda cada perdut (`meta`,
  `reminders.missed`, amb el seu esdeveniment) en la mateixa transacció en què
  l'anota com a donat: tots dos o cap. Els torna a dir en arrencar el vigilant
  fins que Go, després de mostrar l'avís, en confirma les `keys`
  (`reminders.missedShown`); llavors els deixa anar i no els diu més. Un avís
  nou també els inclou, i Go els ajunta per clau, així que no surten
  dues vegades. Si l'aplicació es tanca entre mostrar-lo i confirmar-lo, es
  mostra una altra vegada en arrencar: millor dues vegades que cap. Es va
  triar guardar-lo al nucli i no en un fitxer de Go perquè el nucli ja és
  qui anota què s'ha donat, en el mateix magatzem i en la mateixa transacció.
  El que es guarda està limitat: un perdut sense mostrar l'esdeveniment del
  qual va acabar fa més de 14 dies (el buit que mira una mirada) es deixa anar
  en guardar el següent; els d'un compte suprimit se'n van amb ell.
- **Una vegada**: cada perdut s'anota com a donat abans de retornar-lo, igual
  que els altres; ni una altra mirada, ni un reinici, ni un despertar no el
  repeteixen. Si no es pot anotar, no es mostra i la mirada no s'anota: surt
  en l'avís agrupat de la mirada següent.
- **El que continua en curs** no canvia: es dona sol, dient «Va començar a les…».
- **Comptes en pausa o silenciats**: no mostren res, tampoc després (la seva
  mirada avança igual).
- **El que hi ha al magatzem en mirar**: en despertar es mira abans de
  rellegir els calendaris, així que una reunió cancel·lada o moguda mentre
  l'equip dormia pot sortir com a perduda. I un esdeveniment amb data passada
  que arriba en el buit (una sincronització, un calendari que es torna a
  mostrar) surt com a perdut si el seu avís ha vençut i el seu esdeveniment
  ha acabat dins del buit.
- **Mòbil** (a confirmar pel propietari: és l'únic que encara s'aparta
  de la seva decisió): no té avís agrupat. `take_due` (`pim.refresh`) deixa
  els perduts sense anotar i sense donar, com abans de #225, així que la
  resposta i `PimRefresh.kt` no canvien. Donar-los al mòbil necessita un avís
  agrupat a Android i iOS. Issue de seguiment: #230.
