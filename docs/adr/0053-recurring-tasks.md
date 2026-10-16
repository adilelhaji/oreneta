# ADR-0053: Tasques que es repeteixen

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: el que ADR-0013 i ADR-0039 van deixar fora de #103 (fila SET-20
  del registre d'acceptació amb eM Client 10.4, «Tasks»): crear i editar la
  repetició d'una tasca, i completar una ocurrència sense perdre la sèrie,
  en llistes locals i en llistes CalDAV.

## Decisió

- **Un sol model de repetició per a esdeveniments i tasques:**
  - la regla és `calendar::Recurrence` (la de l'editor d'esdeveniments), amb dos
    camps nous: `month_week` (l'enèsim dia de la setmana del mes, 1–4 o
    -1 per a «l'últim») i `month_day` (el dia del mes quan no és el de la
    data de venciment);
  - l'editor de la repetició és un de sol (`RepeatFields`), compartit per
    l'editor d'esdeveniments i el de tasques. El de tasques ofereix a més «el
    segon dimarts» / «l'últim divendres» al costat de «el dia 13»; el
    d'esdeveniments encara no, perquè Exchange i Google encara no l'escriuen
    des d'aquí;
  - el text de la regla és un valor `RRULE` (RFC 5545), igual en local i
    a CalDAV: `calendar::recurrence` el llegeix, l'escriu i calcula la
    data següent.
- **Quines regles s'escriuen:** diària, setmanal (en un o diversos dies),
  mensual (un dia del mes o l'enèsim dia de la setmana), anual; cada N; sense
  fi, N vegades (`COUNT`) o fins a una data (`UNTIL`, inclusiva).
  - En escriure-la s'explicita tot el que dependria de l'inici:
    `BYDAY` a la setmanal, `BYMONTHDAY` o `BYDAY=2TU` a la mensual,
    `BYMONTH` a l'anual. Així, moure l'inici a l'ocurrència següent
    mai no canvia els dies en què cau.
  - `UNTIL` va com a data si la tasca venç en un dia sense hora, i com el
    final d'aquell dia aquí, en UTC, si té hora (ha de tenir la forma de
    l'inici).
  - En llegir-lo (aclarit el 2026-10-16, #221), un `UNTIL` en UTC és la
    data en què cau aquell instant a la zona d'aquest ordinador, no en UTC:
    RFC 5545 talla la sèrie en aquell instant, i una ocurrència d'aquella data
    a una hora anterior és de la sèrie. En UTC+12 o més, el migdia UTC
    del 31 de desembre ja és l'1 de gener; CI passa les proves del
    calendari també amb `TZ=Pacific/Auckland`.
  - Límit conegut: la regla desa una data i no un instant. És exacte
    quan `UNTIL` és l'última ocurrència o el final del seu dia a la zona
    del lector, que és el que escriu Oreneta. Amb un altre `UNTIL`, una
    tasca amb hora posterior a la d'`UNTIL` aquell dia té una ocurrència
    més que a la RFC: per exemple amb el migdia UTC, o amb el final del
    dia en UTC (`…T235959Z`, com escriuen altres clients) llegit en
    qualsevol zona que no sigui UTC. A més, en tornar a escriure la regla,
    `UNTIL` passa al final d'aquell dia aquí: un `UNTIL` aliè surt fins a gairebé
    un dia més tard i altres clients veuen la sèrie una mica més llarga.
  - «Diària de dilluns a divendres», com l'escriu Thunderbird, es llegeix com a
    setmanal en aquests dies.
- **Fi de mes:** el 31 d'un mes de 30 dies és el 30, i el 29 de febrer
  d'un any no de traspàs, el 28; el mes següent torna al 31. És el que
  fan Outlook i eM Client. RFC 5545 omet aquests mesos; una tasca «el 31»
  que se saltés mig any seria una tasca oblidada. Com que la regla porta
  `BYMONTHDAY=31`, un altre client que segueixi la RFC calcula un altre dia per
  a aquell mes, però el venciment escrit (`DUE`) és el que mana.
- **Hores i canvi d'horari:** l'ocurrència següent conserva l'hora
  de rellotge (una tasca a les 09:00 continua a les 09:00 després del canvi).
  Una hora que el canvi se salta (02:30 la nit en què s'avança) passa a la
  primera que existeix. Es calcula amb la zona d'aquest ordinador.
- **Una tasca que es repeteix necessita data de venciment** (la regla
  compta des d'aquesta); triar una repetició sense data posa avui. Una tasca
  lligada a una conversa no es repeteix.
- **Completar una ocurrència** (el que fa la casella, després de preguntar):
  - es desa una còpia completada de la tasca, sense regla, amb el
    venciment d'aquella ocurrència: el registre del que s'ha fet;
  - la tasca passa a l'ocurrència següent: venciment nou, el
    recordatori a la mateixa distància (i torna a sonar), i la regla amb el
    que queda (`COUNT` baixa en u);
  - l'ocurrència següent és la de després del venciment, encara que ja
    hagi passat; no se salten ocurrències endarrerides;
  - si era l'última (fi per data o per nombre), la tasca es completa sense
    més i no es fa còpia.
- **«Deixar de repetir»:** treu la regla i completa la tasca. Reoberta, ja
  no es repeteix. Les còpies d'ocurrències anteriors es queden.
- **En una llista CalDAV (ADR-0039):**
  - es tria moure la tasca mestra i desar l'ocurrència feta com a
    tasca a part, com Apple Reminders; tasks.org (DAVx⁵) mou la tasca
    igualment, sense còpia. S'escriuen `DUE` i `DTSTART` (mogut els mateixos
    dies, en la seva forma: data, hora amb `TZID` o UTC; s'afegeix si falta,
    perquè la regla compta des d'aquest) i `RRULE`; `STATUS` continua
    `NEEDS-ACTION`. La còpia és un objecte nou amb `STATUS:COMPLETED`. Tots
    dos van amb la sincronització normal, la còpia amb `If-None-Match: *` i la
    mestra amb `If-Match`;
  - es descarta l'altra pràctica, la de Thunderbird: una excepció
    `RECURRENCE-ID` completada per ocurrència. Molts clients (tasks.org,
    Apple Reminders, l'aplicació Tasks de Nextcloud) no la interpreten: veurien
    la sèrie endarrerida per sempre, i l'objecte creix sense límit. Radicale
    i Nextcloud només desen l'objecte; amb la mestra moguda i la regla
    intacta, qualsevol client que segueixi la RFC veu la sèrie bé;
  - la sèrie mai no es perd: la regla i l'`UID` continuen al mateix
    objecte, i la resta que tingui (propietats X-, categories, relacions,
    alarmes) es conserva línia a línia, com a ADR-0039;
  - un recordatori d'una tasca que es repeteix s'escriu relatiu al
    venciment (`TRIGGER;RELATED=END:-PT1H`), que en una sèrie sona a
    cada ocurrència. Si l'alarma ja era relativa i la distància no canvia,
    no es toca;
  - una tasca que es repeteix d'una manera que aquí no s'escriu continua
    sent de només lectura, amb l'avís de sempre: `RDATE`, `EXDATE`,
    ocurrències canviades (`RECURRENCE-ID`), diverses `RRULE`, parts com
    `BYSETPOS` o `BYHOUR`, una anual en un mes diferent del del venciment, o
    una regla sense `DUE`. Es veu i se suprimeix, però no es canvia: canviar-la
    malament seria pitjor.
- **Avisos:** la llista mostra una icona de repetició i la regla en breu
  («Cada setmana», «Cada 3 dies»). En completar una ocurrència es diu quan
  venç la següent.
- **Esquema 61:** columna `tasks.rrule` (valor `RRULE`, buit si no es
  repeteix). La migració torna a llegir les tasques CalDAV marcades com de
  només lectura des de la còpia desada, perquè les que ara es poden
  editar ho siguin sense esperar un canvi al servidor.

## Fora d'abast

- «Regenerar la tasca N dies després de completar-la» (Outlook): no hi ha
  manera estàndard de desar-ho en un VTODO; queda per a un altre lliurament.
- Tasques de Google Tasks, Microsoft To Do (Graph) i Exchange (EWS): continuen
  sense proveïdor; la fila SET-20 ho diu. Exchange ja el té (ADR-0058).
- «Ometre aquesta ocurrència» sense completar-la.
- L'enèsim dia de la setmana en esdeveniments (falta escriure'l a Exchange i
  Google).

## Proves

- `calendar/recurrence/tests.rs`: data següent diària, setmanal en
  diversos dies i cada N, el 31 en mesos curts (30, 28, 29), el 29 de
  febrer, l'enèsim i l'últim dia de la setmana, fi per nombre i per
  data, hora de rellotge a través del canvi d'horari (Madrid i Los
  Angeles, també una hora inexistent), lectura i escriptura de `RRULE` i
  regles rebutjades.
- `task_sync/vtodo/tests.rs`: una regla d'un altre client es llegeix explicitada;
  editar una altra cosa no la toca; passar a l'ocurrència següent escriu
  `DUE`, `DTSTART`, `RRULE` i conserva el que és desconegut; les repeticions
  que no s'escriuen continuen bloquejades.
- `task_sync/tests.rs`: completar contra un servidor de prova (mestra
  moguda, còpia completada nova, recordatori mogut, sense conflicte a la
  lectura següent, fi per nombre), deixar de repetir, una tasca nova
  amb regla i la migració.
- `store/task_lists/tests.rs`: el mateix en una llista local.
- Integració amb Radicale (`integration_caldav_tasks_test.go`): completar
  una ocurrència i llegir-la de tornada del servidor real.
- Frontend: `RecurringTasks.test.tsx` (editor, indicador i elecció en
  completar). Tot amb `TZ=Asia/Tokyo` i `TZ=America/Los_Angeles` a més de
  la zona de l'equip.
