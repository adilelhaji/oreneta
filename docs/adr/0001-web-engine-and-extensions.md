# ADR-0001: Mantenir el motor web natiu; adoptar les funcions de les extensions com a funcionalitats pròpies

- **Estat:** Acceptada
- **Data:** 2026-09-07
- **Decisors:** Adil El Haji (mantenidor)
- **Relacionat:** [ADR-0002](0002-remote-label-linking.md)

## Context

Oreneta està construït amb [Wails](https://wails.io), que renderitza la
interfície en la vista web nativa de cada plataforma en lloc d'un navegador
incrustat:

| Plataforma | Motor |
|---|---|
| Linux | WebKitGTK 4.1 |
| macOS | WKWebView |
| Windows | WebView2 (basat en Chromium, mitjançant `go-webview2`) |

Es va plantejar la pregunta: podria Oreneta admetre extensions de Google
Chrome —correcció ortogràfica i gramatical, bloqueig de rastrejadors i
anuncis, traducció— com ho fa un navegador complet?

### L'acoblament a Wails, mesurat

Abans de comparar alternatives, es va mesurar la dependència real de Wails
en lloc de suposar-la:

- La interfície es comunica amb el rerefons per mitjà d'un únic pont genèric,
  `window.go.main.App.Invoke(command, payload)` (vegeu
  [`frontend/src/lib/bridge.ts`](../../frontend/src/lib/bridge.ts)), i no
  per mitjà d'unes 200 vinculacions generades. Cadascun dels 201 mètodes
  d'`App` es despatxa per mitjà d'aquesta única crida.
- El procés de Go ja tracta el motor de Rust (`meron-core`) com un procés
  auxiliar (sidecar) per stdio/JSON-RPC (vegeu [`sidecar.go`](../../sidecar.go)),
  no com una biblioteca. No està gens acoblat a Wails.
- Les crides al runtime de Wails en la capa de Go es limiten als quadres de
  diàleg de fitxers, la safata del sistema, el control de finestres i
  `BrowserOpenURL`: aproximadament una dotzena de punts de crida, tots ells
  codi d'unió amb l'entorn de la plataforma més que no pas arquitectura.
- Tres esdeveniments emesos (`mailto.open`, `notification-clicked`,
  `update.status`) travessen el pont de Go a la interfície.

És a dir: portar la *interfície* i el *motor de Rust* a un altre entorn
d'execució seria gairebé gratuït. El cost de qualsevol canvi de motor es
concentra en les ~4.000 línies de codi d'unió amb la plataforma en Go
(safata, notificacions, esdeveniments d'energia, quadres de diàleg natius,
activació del corrector ortogràfic, l'actualitzador) i en refer
l'empaquetament per a quatre canals (Linux AppImage/deb/snap/flatpak,
Windows, macOS DMG, Mac App Store), a més de la compilació d'Android, que no
passa per Wails en absolut i no es veu afectada en cap cas.

### Què requereix realment admetre extensions basades en Chromium

Cap vista web nativa (WebKitGTK, WKWebView, ni WebView2 tal com està
connectat mitjançant `go-webview2`) exposa una API per a carregar extensions.
L'única manera d'executar extensions de Chrome des d'una aplicació Wails
seria només a Windows, modificant `go-webview2` per a accedir a l'API
d'extensions pròpia de WebView2 (encara en evolució); no hi ha cap
equivalent a Linux ni a macOS.

L'única manera de carregar extensions a **les tres plataformes** és
incrustar Chromium directament —Electron o CEF— i, fins i tot així, el suport
«complet» d'extensions no vol dir el mateix que en un navegador:

- El `session.loadExtension()` del mateix Electron està pensat per a
  extensions de DevTools, no per a extensions generals: sense finestres
  emergents d'acció del navegador, sense pàgines d'opcions, sense flux
  d'instal·lació des de la Web Store.
- La biblioteca de tercers que cobreix aquest buit,
  `electron-chrome-extensions`, implementa aproximadament 70 mètodes de l'API
  `chrome.*` (`action`, `tabs`, `windows`, `runtime`, `storage`, `contextMenus`,
  `webNavigation`, `cookies`/`notifications`/`commands` parcials), però manté
  els scripts de fons sempre actius en lloc de ser service workers realment
  latents, no admet extensions en sessions no persistents o d'incògnit, i
  té llicència **GPL-3.0**, amb una llicència de mecenatge de pagament
  separada que es requereix per a l'ús propietari (irrellevant per a Oreneta,
  que és AGPL-3.0, però val la pena deixar-ne constància).
- Un paquet complementari, `electron-chrome-web-store` (MIT), hi afegeix la
  instal·lació i l'actualització automàtica des de la Chrome Web Store, però
  el seu README és explícit que el seu script de precàrrega s'ha de
  distribuir sense empaquetar, una restricció d'empaquetament pròpia.
- Les vinculacions de Go per a CEF són un ecosistema més petit i menys
  mantingut, i el suport d'extensions en aquest cas és parcial i s'està
  retirant a l'origen, no ampliant.

Per tant, el «suport complet d'extensions de Chrome» només és disponible, en
el millor dels casos, a Electron, i fins i tot allà és el suport complet
d'extensions de CEF/Electron, que ja és un subconjunt del que ofereix un
navegador real.

### Què costaria incrustar Chromium, mesurat respecte del que és Oreneta avui

| | Avui (Wails) | Amb Electron |
|---|---|---|
| Mida instal·lada | ~72 MB (28 MB aplicació + 44 MB nucli) | +~150 MB de runtime de Chromium |
| RAM en repòs | La que ja utilitzi la vista web del sistema operatiu | +150–300 MB |
| Ritme de pedaços de seguretat | Segueix les actualitzacions de WebKit/Edge del sistema operatiu | Oreneta ha de publicar una compilació nova per cada CVE de Chromium, aproximadament cada mes |
| Mac App Store | Es distribueix avui | El sandbox de la MAS no permet carregar extensions arbitràries; caldria una compilació MAS separada i sense extensions o abandonar la MAS |
| Fusions des de Meron | La interfície i la lògica del nucli en Go encara es fusionen netament | Les ~4.000 línies de codi d'unió amb la plataforma en Go divergirien completament, perquè Electron les substitueix per les seves pròpies API; Rust i la interfície encara es fusionen |
| Content-Security-Policy / privadesa | `connect-src 'self'`; totes les dades passen pel rerefons de la mateixa aplicació | Cada extensió instal·lada es comunica amb els seus propis servidors; la CSP i l'afirmació "everything stays on your computer" del `README.md` deixarien de ser certes sense matisos |
| Empaquetament | 4 scripts existents (`build.sh`, `build-windows.sh`, `build-mas.sh`, `gen-latest-json.sh`) | Reescriptura completa sobre `electron-builder`, amb nova signatura i nova notarització a cada plataforma |

Res d'això no és desqualificador per si sol, però tot plegat canvia el tipus
d'aplicació que és Oreneta: l'eslògan del README és "fast", i tot el sentit
de fer un fork de Meron per a tenir suport natiu d'EWS era evitar
precisament aquesta categoria de client pesant en recursos, a l'estil d'un
pont IMAP.

## Decisió

**Oreneta manté la seva vista web nativa a totes les plataformes. No
incrusta Chromium i no allotja extensions de Chrome.**

En lloc d'això, les *funcions* concretes per a les quals un usuari
recorreria a una extensió de Chrome s'adopten com a funcionalitats pròpies,
integrades directament a Oreneta, i s'executen localment sempre que la
funció ho permeti:

| Funció | Extensió a què recorre la gent | Adoptat en lloc seu | Llicència | Xarxa |
|---|---|---|---|---|
| Gramàtica i estil | Correctors a l'estil de Grammarly | [Harper](https://github.com/Automattic/harper) (motor gramatical en Rust), executat com a WASM dins del redactor TipTap | Apache-2.0 | Cap |
| Bloqueig de rastrejadors i píxels | uBlock Origin i similars | La llista de filtres [EasyPrivacy](https://easylist.to), aplicada en el sanejador HTML de missatges que ja té Oreneta | GPL-3.0-or-later (doble llicència amb CC-BY-SA-3.0-or-later; s'ha triat GPL-3.0-or-later com l'opció compatible amb programari) | Cap un cop la llista es distribueix amb l'aplicació; només actualitzacions periòdiques de la llista |
| Traducció | Extensions de Google Translate / DeepL | [Firefox Translations](https://github.com/mozilla/firefox-translations) (el motor Bergamot), executat com a WASM, amb models per parell d'idiomes baixats a demanda | MPL-2.0 | Només per a obtenir un model la primera vegada; després, la traducció s'executa sense connexió |

Les tres llicències s'han comprovat directament amb el fitxer `LICENSE` de
l'origen (no afirmades de memòria) i són compatibles amb l'AGPL-3.0
d'Oreneta: Apache-2.0 i MPL-2.0 es poden combinar explícitament, segons els
seus propis termes, amb obres cobertes per l'AGPL-3.0, i la FSF reconeix
GPL-3.0-or-later com a compatible amb l'AGPL-3.0 per a una obra combinada.
Això no substitueix el criteri jurídic del mateix mantenidor abans de
publicar, però és un punt de partida comprovat i no una suposició.

Una quarta funció, la correcció gramatical basada en servidor mitjançant
**LanguageTool** (LGPL-2.1, que s'ha de tornar a verificar quan se'n
defineixi realment l'abast), es deixa deliberadament com a opcional i fora
d'aquesta fase: requereix enviar el text dels missatges a un servidor, cosa
que ha de ser una activació explícita per compte i no un comportament per
defecte, i no és necessària per a respondre la petició original.

Cadascuna d'aquestes tres dependències té la seva pròpia entrada al registre
SOUP (Software of Unknown Provenance) a `docs/soup.md` **quan s'integri
realment**, no en aquest ADR: la versió fixada, el punt d'integració i
l'enfocament de verificació van al costat del codi que les utilitza, no en
un registre de decisió escrit abans que cap de les tres existeixi a l'arbre.

## Conseqüències

- Cap extensió de Chrome —de cap mena, de cap botiga— no s'executarà mai
  dins d'Oreneta. Si això canvia, caldria revisar aquesta decisió, no
  revertir-la en silenci.
- Totes les crides de xarxa futures que facin aquestes tres funcionalitats
  han de passar pel rerefons de Go/Rust, mai directament des de la
  interfície, d'acord amb la política `connect-src 'self'` existent. La
  baixada única del model de traducció i qualsevol crida futura a
  LanguageTool són els únics camins de xarxa que preveu aquest ADR, i tots
  dos han de ser visibles per a l'usuari abans que tinguin lloc.
- Es preserven tant la compilació per a la Mac App Store com el camí de
  fusió net des de `nonbili/meron`.
- La mida instal·lada d'Oreneta, l'ús de memòria en repòs i el ritme
  d'actualitzacions es mantenen com avui; no es paga cap dels costos
  d'Electron esmentats.
- Si un requisit futur necessita realment una extensió de Chrome real (no
  una funció que casualment ofereixi una extensió), aquest requisit entra en
  conflicte amb aquest ADR i s'ha d'escalar, no implementar esquivant-lo.

## Alternatives considerades

- **Electron, suport complet d'extensions** (`electron-chrome-extensions` +
  `electron-chrome-web-store`). Rebutjada: taula de costos anterior, a més
  del conflicte amb la Mac App Store i la dependència GPL-3, que requereix
  una llicència de mecenatge per a qualsevol ús tancat futur.
- **Electron, només amb una llista curada d'extensions permeses** (sense Web
  Store, distribuint un conjunt fix d'extensions verificades). Redueix la
  superfície de privadesa, però continua pagant tot el cost de
  mida/RAM/ritme de pedaços/MAS per un benefici més limitat que adoptar
  directament les funcions; rebutjada pels mateixos motius.
- **Modificar `go-webview2` per a l'API nativa d'extensions de WebView2,
  només a Windows.** Barat (dies, no mesos) i donaria extensions reals, però
  només en una de les tres plataformes, i continua obrint les qüestions de
  CSP i privadesa anteriors. No s'hi avança tret que més endavant
  s'identifiqui una necessitat específica de Windows.
- **No fer res.** Rebutjada: la correcció ortogràfica ja és nativa de cada
  sistema operatiu, però la gramàtica, el bloqueig de rastrejadors i la
  traducció eren mancances reals que valia la pena cobrir, encara que no
  allotjant extensions.
