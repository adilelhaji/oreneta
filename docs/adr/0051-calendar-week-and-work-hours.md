# ADR-0051: Setmana i horari laboral del calendari

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-18 de la paritat amb eM Client 10.4 (#100),
  «Calendari → General». Les visualitzacions d'agenda, setmana i mes, el canvi
  d'hora i els calendaris locals, de Google, Exchange i CalDAV ja estaven
  resolts i provats; faltaven el primer dia de la setmana, l'horari
  laboral i el que porta un esdeveniment nou. El temps meteorològic queda fora
  (vegeu «Pendent»).

## Decisió

- **Dues files a `settings`:**
  - `calendar_week_start` (`settings$.calendarWeekStart`): `locale`,
    `sunday`, `monday` o `saturday`. Va sola i com a text pla perquè el
    mòbil la pugui llegir amb `app.prefsGet` sense entendre un objecte;
  - `calendar_general` (`settings$.calendar`): números de setmana, inici i
    fi de la jornada (minuts des de mitjanit), dies laborables, «només
    setmana laboral», durada i recordatori d'un esdeveniment nou. En llegir-la,
    cada camp no vàlid torna al seu valor per defecte per separat
    (`sanitizeCalendarPrefs`); una jornada que acaba abans de començar torna
    sencera a 9:00–17:00.
- **Primer dia de la setmana:**
  - per defecte, el de la regió del sistema (`navigator.languages[0]`), no
    el de l'idioma de la interfície: només el del sistema porta regió, i una
    interfície en anglès a Madrid continua tenint setmanes de dilluns;
  - es pren d'`Intl.Locale` (`getWeekInfo()` o `weekInfo`), que tenen
    WebView2, WebKitGTK i JavaScriptCore; sense això, d'una taula amb les dades
    de CLDR per regió (diumenge: EUA, Canadà, Japó, Brasil, Portugal…;
    dissabte: Egipte, Iran, Golf…; dilluns: la resta, gairebé tot Europa). Un
    idioma sense regió pren la probable (`de` → DE, `fa` → IR);
  - la persona pot fixar diumenge, dilluns o dissabte; l'opció regional diu
    quin dia significa («Predeterminat regional (dilluns)»);
  - l'utilitzen les visualitzacions de setmana i mes (ordre de columnes,
    capçaleres i graella de sis setmanes), la finestra que es demana al nucli,
    l'etiqueta del període i els botons de dies d'una repetició setmanal. Els
    camps de data de l'editor són els natius del sistema (`<input type="date">`)
    i segueixen la configuració regional del sistema, no aquesta preferència.
- **Números de setmana** (opcional, desactivat per defecte): ISO 8601 quan la
  setmana comença en dilluns (la setmana 1 conté el primer dijous), sigui
  quina sigui la regió; si comença un altre dia, la regla de la regió: la
  setmana 1 és la primera amb almenys `minimalDays` dies de l'any, que a les
  regions de diumenge i dissabte és la que conté l'1 de gener. `Intl` ja no
  dona `minimalDays` (es va treure de la proposta), així que surt sempre de la
  taula de CLDR (4 a gairebé tot Europa, 1 a la resta). Els dies es compten
  sobre dates, no sobre segons, així que un canvi d'hora no mou una setmana.
  Es mostren a la cantonada de la visualització de setmana («W42» en anglès) i
  en una columna a l'esquerra del mes.
- **Horari i dies laborables:**
  - per defecte de 9:00 a 17:00, i laborables tots els dies fora del cap
    de setmana de la regió (dilluns a divendres a Europa i als EUA; diumenge a
    dijous a Egipte; a l'Iran, tots menys el divendres). Triar dies els fixa
    i deixa de seguir la regió; sempre en queda almenys un;
  - les visualitzacions de dia i setmana ombregen les hores fora de la jornada
    i els dies no laborables sencers, i s'obren desplaçades a mitja hora abans
    de l'inici de la jornada;
  - l'ombrejat es calcula en hores de rellotge de paret, igual que la posició
    dels esdeveniments (`lib/calendarGrid`): un dia de 23 o 25 hores continua
    ombrejat de 0:00 a 9:00 i de 17:00 a 24:00, i la seva jornada continua
    durant vuit hores;
  - «Setmana laboral» a la barra de la visualització de setmana (i a
    Paràmetres) amaga els dies no laborables; l'etiqueta del període anomena
    els dies que es veuen. Una setmana sense cap dia laborable es mostra
    sencera. La visualització de dia mai no es retalla.
- **Esdeveniment nou:** dura el que s'ha triat (60 minuts per defecte) i porta
  el recordatori triat (cap per defecte, com fins ara, perquè ningú no
  comenci a rebre avisos per una opció nova). Fer doble clic en un dia
  del mes el comença a l'inici de la jornada en lloc de fer-ho a les 9:00 fixes.
- **Mòbil:** l'agenda llegeix `calendar_week_start` en obrir-se. Amb un dia
  fixat, la finestra de 14 dies comença el primer dia de la setmana actual
  (pàgines de setmanes senceres, com a l'escriptori); amb «regional» continua
  començant avui, perquè el codi comú no té dades de setmana per regió.
  Si la preferència canvia i l'agenda era a la finestra d'avui, es
  recol·loca; una finestra a la qual s'ha navegat no es mou.

## Alternatives descartades

- **Prendre la regió de l'idioma de la interfície:** `es`, `ca` o `en` no diuen
  on es viu; `en` seria EUA i donaria diumenge a qui fa servir la interfície
  en anglès a Europa.
- **Una sola fila amb tot el calendari:** el mòbil només llegeix valors
  simples d'`app.prefsGet` (`parseAppPrefsResponse` descarta objectes), i el
  primer dia és l'únic que necessita.
- **ISO 8601 per a tots els números de setmana:** als EUA, al Japó o al Brasil
  la setmana de l'1 de gener és la 1 i la compten en diumenge; numerar amb ISO
  una graella de diumenge dona setmanes partides.
- **Recordatori de 15 minuts per defecte, com eM Client:** canviaria el que
  fa avui cada esdeveniment nou sense que ningú ho demani.

## Pendent (#100 continua oberta)

- **Temps meteorològic:** eM Client el mostra al calendari, però
  exigeix un servei en línia (envia la ubicació a un tercer i pot
  necessitar una clau d'API). No s'implementa: queda fora d'abast fins
  que el propietari decideixi servei, privadesa (quina ubicació s'envia i
  quan) i si la clau la posa la persona.
- El primer dia «regional» al mòbil (necessita dades de setmana de la
  plataforma: `java.time.temporal.WeekFields` a Android, `Calendar.firstWeekday`
  a iOS).
- Ombrejat i números de setmana al mòbil, que avui només té agenda.
- Les agrupacions del correu per «aquesta setmana» (`lib/dateGroups.ts`) i les
  dreceres «dilluns al matí» continuen en setmanes de dilluns.
- Comprovació nativa a Windows (WebView2) de la regió del sistema i dels
  camps de data.
