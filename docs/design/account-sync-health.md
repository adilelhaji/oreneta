# Visibilitat de la sincronització dels comptes (#165 / #150)

## Contractes observats

- `mail.syncError` identifica un compte i un missatge de diagnòstic, però cap
  identificador estructurat de carpeta ni d'operació. Diversos comptes
  concurrents poden fallar. La interfície anterior només conservava l'últim
  compte i n'esborrava l'error en descartar l'avís o amb qualsevol èxit del
  mateix compte.
- `mail.synced` pot indicar una llista de carpetes o una sola carpeta
  actualitzada; `mail.newMessages` indica activitat de missatges nous. Cap dels
  dos no demostra que totes les carpetes, calendaris, contactes o operacions en
  segon pla estiguin al dia. Els esdeveniments del calendari continuen sent
  independents. Els errors d'RSS fan servir el canal d'errors genèric i no es
  poden atribuir aquí amb seguretat.
- El pont d'escriptori `mail.sync` actua per defecte sobre la safata d'entrada
  i retorna `online: false` quan el procés auxiliar (sidecar) no és disponible
  o la sol·licitud ha fallat, fins i tot amb `ok: true`. `online: true` només
  confirma que el procés auxiliar ha acceptat una sol·licitud: el seu gestor
  `messages.sync` pot retornar `queued: true` abans que la feina acabi, i la
  feina en pausa o que ja s'executa es pot ometre. No demostra ni la
  connectivitat ni la compleció i no pot resoldre un error anterior d'abast de
  carpeta desconegut.
- L'estat `needs_reconnect` del compte és el senyal explícit d'autenticació. No
  hi ha cap flux complet d'inici i fi de la sincronització en segon pla ni cap
  hora persistent de l'última sincronització completa.

## Lliurament limitat

Es conserva un registre per compte, només per a la sessió, i un registre a part
sense atribuir. Descartar l'avís amaga l'avís destacat, no el registre. Un
control compacte de sincronització del compte manté els detalls accessibles.
Els comptes independents no se sobreescriuen mai entre ells. Els registres dels comptes eliminats se suprimeixen; una compleció tardana d'un reintent no en pot tornar a
crear el registre ni sobreescriure un error més recent.

Es mostra l'evidència existent: autenticació necessària, compte en pausa,
sol·licitud pendent, sol·licitud acceptada (no sincronització completa), error
no resolt, activitat parcial del correu o desconegut. Qualsevol marca de temps
s'etiqueta com a activitat del correu observada durant aquesta sessió, mai com a
actualitat completa de la bústia. No s'inventa cap llindar de caducitat o
d'antiguitat, no es dedueix l'estat fora de línia a partir d'un text d'error
arbitrari i no es converteix una resposta no confirmada en un anunci d'èxit.

La recuperació fa servir el `mail.sync` existent per a aquell compte exacte i la
configuració existent del compte per a la reconnexió. No invoca mai l'enviament,
cap cua d'enviament ni cap escriptura de Graph. Els comptes en pausa ofereixen
la configuració en lloc d'un reintent que no faria res. Un registre sense compte
no té reintent; no pot deduir el compte seleccionat. Els diagnòstics en brut,
els testimonis (tokens) i els detalls d'error del servidor no es mostren en
aquesta superfície. Els detalls fan servir text que s'ajusta, controls de
teclat normals i un anunci d'estat cortès sense moure el focus en resposta als
esdeveniments.

Això amplia l'estat observable existent de la interfície; no s'hi introdueix
cap persistència, motor de sincronització, format d'esdeveniment del rerefons
ni arquitectura de recuperació nous. Un abast d'error desconegut implica que un
èxit parcial posterior conserva un estat degradat o no verificat. Reiniciar
l'aplicació perd aquestes observacions; no en certifica la salut. La cobertura
completa del servei, els anuncis natius i la recuperació del proveïdor
continuen sent feina d'acceptació de #150.

## Límit de la verificació

La cobertura automatitzada inclou errors simultanis, el descart d'avisos,
activitat parcial o sense atribuir, comptes desconeguts o eliminats, comptes en
pausa o que requereixen autenticació, sol·licituds a la cua, confirmacions
falses, absents o rebutjades, sol·licituds duplicades, errors més recents i
respostes tardanes. Les proves de components cobreixen el focus, la
configuració exacta del compte i l'omissió dels diagnòstics en brut. Els casos
d'entrada de producció cobreixen el castellà, el mode clar i fosc, 600/1440 px,
el teclat, el zoom al 200 %, el restabliment de la sessió i l'absència
d'invocació d'enviament. Les revisions tècniques i de producte lleugeres estan
resoltes; la CI del commit exacte és la condició per fusionar.

La primera part canvia el tauler de recuperació del compte i les observacions
d'esdeveniments. La presentació dels errors del calendari conserva el contracte
existent i l'acceptació d'aquest tauler no la certifica. Aquí no es canvia cap
executable natiu, instal·lador, sessió de proveïdor ni versió de producció.

## Continuació de l'actualització manual (#167)

Els menús de la bústia, la configuració ràpida, les dreceres de teclat i la
paleta d'ordres comparteixen `syncMail`. Abans, aquesta acció ignorava
`online`, s'empassava els errors dels comptes unificats i anunciava la
compleció immediatament. Ara fa servir la mateixa funció auxiliar de
sol·licitud per compte que el tauler de recuperació. L'actualització unificada
només s'adreça als comptes inclosos; els comptes en pausa o que requereixen
autenticació s'ometen. Graph continua sent de només lectura. Les
actualitzacions manuals repetides no dupliquen una sol·licitud en curs.

La resposta informa de les sol·licituds acceptades, no confirmades, ja
pendents i omeses, incloent-hi els resultats mixtos. L'acceptació no és mai la
compleció de la sincronització i no esborra mai un error conegut. Aquesta acció
no mostra ni registra errors en brut. L'actualització limitada de la llista es
manté després d'una sol·licitud acceptada: `mail.sync` actua per defecte sobre
la safata d'entrada, mentre que la sol·licitud de llista actualitza la carpeta
seleccionada, el rol unificat o la cerca en directe. Els esdeveniments en segon
pla existents actualitzen les files quan arriben dades més tard. Cap de les dues
sol·licituds no implica una actualitat completa. Els diagnòstics de càrrega de
la llista ometen els errors del servidor en brut. La resposta informativa fa
servir una icona neutra, també per a les sol·licituds acceptades, pendents i
omeses, i els avisos llargs s'ajusten dins de la finestra sense encongir-ne la
icona. Una resposta per a una vista que l'usuari ha deixat no pot mostrar un
avís de compleció a la vista nova. L'indicador de pendent descriu l'enviament
de la sol·licitud, no la sincronització en segon pla.

## On és l'estat: la banda superior (#345)

Des de #345 (ADR-0068 §2, peça 13c; vegeu
[top-band.md](top-band.md#el-final-de-la-banda-345)), l'estat de la
sincronització és al final de la banda superior, i ja no en una regió sempre
visible sota la capçalera.

- **El resum** és un botó amb una icona i els mateixos textos que la regió
  d'abans: «{count} requereixen atenció» o «Estat de la sincronització completa
  desconegut». No hi ha cap text nou i mai no diu «Sincronitzat»: continua sense
  haver-hi cap senyal de sincronització completa. Una sol·licitud en curs no
  canvia el resum, com abans; una sense confirmar compta com a atenció, com
  abans. Per sota de 1025 px es veu només la icona, amb el resum com a nom
  accessible i com a indicació.
- **L'anunci** és el d'abans: una sola regió `role="status"` cortesa i sencera,
  amb el resum, ara visualment oculta al costat del botó. Hi és abans de cap
  canvi, tant si hi ha la barra com si no, de manera que una fallada s'anuncia
  una vegada i el focus no es mou.
- **El detall** (cada compte, la seva observació i les seves accions, i el
  problema sense compte) s'obre des del botó en una finestra emergent no modal
  ancorada al botó, amb les mateixes accions, els mateixos textos i les mateixes
  regles: cap diagnòstic en brut, la configuració exacta del compte, cap
  reintent per a un compte en pausa, que ha de tornar a iniciar la sessió o
  sense compte. Escapada la tanca i torna el focus al botó.
- **La barra d'amplada completa** sota la capçalera només hi és en el cas
  destacat: un compte ha de tornar a iniciar la sessió, o hi ha una fallada o un
  problema sense compte que no s'ha descartat. Es queda fins que es resol o es
  descarta, amb el seu botó i el seu detall; una sessió per tornar a iniciar no
  es pot descartar. Fora d'aquest cas no hi és, perquè ho diu la banda.
  Descartar continua amagant l'avís destacat, no el registre: el resum de la
  banda continua comptant la fallada descartada.
- **Sense cap compte** ni cap problema sense compte no es mostra res, com abans,
  i la pantalla d'alta del primer compte no té l'estat.
- **Proves:** `components/shell/SyncStatus.test.tsx` i les proves «#345»
  d'entrada de producció (vegeu [top-band.md](top-band.md#proves)). Les proves
  d'aquest document que trobaven el resum a la regió de sota la capçalera el
  busquen ara a la banda, i la barra només quan hi ha una fallada.
