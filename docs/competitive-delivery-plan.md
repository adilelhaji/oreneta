# Oreneta: pla per competir amb eM Client

Revisió: **2026-10-05**. Programa: [#21](https://github.com/adilelhaji/oreneta/issues/21).
Codi auditat: `c3c562f53ed3331a1fb06dfba128c00f65931629`.
Aquest document actualitza l'ordre d'execució del [pla de paritat](emclient-parity-plan.md),
sense eliminar-ne la matriu completa ni aprovar canvis d'arquitectura. Les fases R0–R4
són portes de lliurament; les fites S01–S13 continuen agrupant les àrees de treball.

## Objectiu i criteri comercial

Primer, aconseguir una alternativa fiable a Windows per al correu professional amb diversos
comptes; després, completar la informació personal, les integracions i la paritat per plataforma.
Una versió útil per a un segment pot competir sense cobrir totes les funcions,
però n'ha de declarar l'abast: **correu de Windows validat** no vol dir **paritat
completa amb eM Client**. L'èxit comercial es comprovarà amb usuaris, no amb
el nombre d'incidències tancades ni amb un percentatge de pantalles semblants.

La referència estable es manté en **eM Client 10.4.5674.0 per a Windows**.
L'historial oficial consultat el 5 d'octubre mostra **11.0.865.0 com a beta**;
els seus canvis es registren a #117, sense ampliar en silenci l'acceptació estable.
Fonts: [historial](https://www.emclient.com/release-history?os=win),
[correu](https://www.emclient.com/features-email),
[calendari/tasques](https://www.emclient.com/features-calendar),
[funcions generals](https://www.emclient.com/features-overview).

La diferenciació proposada és concreta: interfície coherent i ràpida, estat dels
comptes comprensible, recuperació visible, control del context de l'assistent i
funcions locals de privadesa/idioma dins dels ADR ja aprovats. Són objectius
que cal mesurar; no s'afirma que Oreneta ja superi el competidor en aquests punts.

## Estat reconciliat

- S'han revisat les **65 incidències obertes** i els treballs tancats relacionats.
  Totes tenen cabuda en l'abast; no es tanquen per haver-ne lliurat una part.
  L'[auditoria individual](competitive-backlog-audit.md) n'assigna la fase, la prioritat i la decisió.
- #21 estava tancada tot i que l'acceptació integral continuava pendent: es reactiva
  com a programa, conservant-ne l'historial i sense crear una èpica duplicada.
- #83/#84/#85 ja van lliurar els temes cobalt, la vista convencional i la correcció del
  límit estret. No cal tornar-los a implementar. #33–#38 conserven l'acabat restant.
- #125/#127/#128 aporten Graph de lectura; l'enviament, les accions i els adjunts continuen fora
  del contracte actual. #47 es descompon en tres lliuraments verificables.
- #50–#54 tenen avenços integrats de correu brossa, assistent, dades de rendiment i
  diagnòstics. Els seus criteris complets i les proves natives/de proveïdor continuen oberts.
- L'última CI del codi auditat té set suites satisfactòries
  ([execució](https://github.com/adilelhaji/oreneta/actions/runs/34483379658)).
  El binari local és del SHA `e20fe87a072f49486609f689456727958d02b2db`:
  el seu manifest n'acredita l'arrencada, però no l'instal·lador ni els proveïdors reals.
- El registre actual conté 4 files `implemented-unverified`, 8 `partial` i
  27 `unassessed`. És un inventari parcial d'acceptació, no una mesura de tota
  l'aplicació ni una prova d'absència de les funcions no avaluades.

## Seqüència de lliuraments

Avenç de disseny posterior a l'auditoria (2026-10-05): controls compartits
#152/#153, selecció de taula #154/#155, mida i accions del lector #156/#157,
i cicle de focus dels diàlegs #158/#159 integrats. L'ADR 0009 va aprovar la vista general i
les excepcions per carpeta; #160 implementa el contracte i el seu
[configurador de columnes](design/mailbox-columns.md). Aquests lliuraments no tanquen
els criteris complets de #33–#37 ni substitueixen l'acceptació nativa. Els binaris
locals no s'han actualitzat amb aquestes millores.

#177 estén l'[acabat visual](design/screen-consistency.md) a les pantalles
existents: estats semàntics, icones, ombres i moviment coherents; Persones,
Tasques i Calendari adaptats a finestres estretes i menú d'accés comú. Inclou
la lectura completa de textos llargs, l'obertura amb el teclat i les dates del calendari
segons l'idioma de l'aplicació. #33/#38 conserven l'acceptació funcional i nativa
restant; aquest lliurament no afegeix sincronització de contactes/tasques ni funcions
pendents de calendari.

Descobriment de la configuració: #163/#164 incorpora cerques EN/ES, destinacions de compte,
teclat i conservació dels editors; [contracte i límits](design/settings-discovery.md).
#165 afegeix [observacions de sincronització per compte](design/account-sync-health.md)
sense esborrar incidents en amagar avisos ni certificar recuperació per respostes
parcials. #149/#150 conserven pendent l'acceptació completa i nativa.

| Porta | Resultat per a l'usuari | Treball principal | Condició de sortida |
|---|---|---|---|
| **R0 — Confiança i evidència** | Conservar les dades i entendre les fallades abans d'ampliar-ne l'ús | #9/#12, #27–#29, contractes acotats #24/#25; mesurar #53, preparar #98/#114 i resoldre l'abast de la recuperació | Reproduccions de riscos resoltes o capacitat deshabilitada per a l'abast; enviament incert sense reintent cec; inventari de dades i decisió de recuperació; proves automatitzades en verd i límits explícits |
| **R1 — Correu de Windows competitiu** | Configurar comptes, llegir, cercar, respondre amb fitxers i organitzar sense fricció | #30–#40, #43/#45, #46–#48, #86–#89, #92/#93/#95/#96; noves slices de Graph, OAuth, salut i configuració | Flux complet a l'aplicació nativa, proveïdor per proveïdor; esborranys recuperables; UX comparada; instal·lació/actualització comprovades; cap afirmació de compatibilitat basada només en simulacions |
| **R2 — Agenda i organització personal** | Coordinar reunions i mantenir contactes, tasques i notes | #28/#38/#41/#42, #99–#104; importació/recuperació #112/#113 segons els ADR | Sincronització, conflictes, recurrència, invitacions, permisos i recuperació demostrats; arquitectura nova aprovada abans del codi |
| **R3 — Paritat estable completa a Windows** | Cobrir l'automatització, la privadesa, l'idioma i les integracions de l'inventari | #49–#52, #90/#91/#94/#97, #105–#111; completar #22/#98/#112–#114 | Totes les files obligatòries de Windows/proveïdor verificades, inclosos els formats i serveis menys comuns; qualsevol exclusió manté la declaració de paritat parcial |
| **R4 — Altres plataformes i evolució** | Estendre l'acceptació sense degradar el que ja existeix | #37/#55/#115, amb #116/#117 en un inventari separat | Evidència nativa pròpia de macOS i regressions de Linux; mòbil/beta tenen abast i acceptació independents |

Les fases no són una cascada rígida: l'accessibilitat #37, la privadesa #54, el rendiment
#53 i les proves per proveïdor #98 s'apliquen des de R0. Una fallada reproduïda
d'integritat/seguretat passa per davant de qualsevol millora visual. El descobriment de calendari,
notes, tasques i xat es pot avançar; la seva implementació espera les decisions necessàries.
La importació i la recuperació necessàries per a un participant han d'estar verificades
abans del seu pilot, encara que la cobertura completa de formats pertanyi a R2/R3.

## Primeres iteracions executables

1. **Fiabilitat:** reconciliar #27/#28/#29 i #9/#12 amb el codi actual;
   convertir cada risc en una reproducció automatitzada i resoldre'l en la seva incidència.
   Obrir només les decisions concretes de #24/#25 que impedeixin la solució.
2. **Evidència i continuïtat:** preparar [#145](https://github.com/adilelhaji/oreneta/issues/145) i [#148](https://github.com/adilelhaji/oreneta/issues/148);
   continuar #170–#173 d'acord amb l'ADR-0010 després de resoldre #146 i iniciar
   [#147](https://github.com/adilelhaji/oreneta/issues/147). Actualitzar l'exposició de #46
   per compte/operació; no ajornar Graph fins que s'acabi el redisseny.
3. **Correu complet:** executar [#142](https://github.com/adilelhaji/oreneta/issues/142) i [#141](https://github.com/adilelhaji/oreneta/issues/141) com a slices
   independents; [#143](https://github.com/adilelhaji/oreneta/issues/143) després del contracte durable de #29. Completar
   #39/#40 amb recuperació i adjunts, no només amb l'aparença.
4. **Experiència diària:** #33/#34/#35/#36, [#150](https://github.com/adilelhaji/oreneta/issues/150), [#149](https://github.com/adilelhaji/oreneta/issues/149)
   i #43. Verificar un flux sencer per increment, amb #37 des del començament.
5. **Candidat acotat:** [#144](https://github.com/adilelhaji/oreneta/issues/144), files reals de [#145](https://github.com/adilelhaji/oreneta/issues/145) i
   [#147](https://github.com/adilelhaji/oreneta/issues/147); comparar els fluxos aplicables a l'abast del candidat i decidir l'entrada
   de participants mitjançant #55. La publicació continua sent una acció separada.

Treballar en iteracions de fins a dues setmanes quan es conegui la capacitat,
amb un resultat demostrable per slice. Limitar el treball en curs a un lliurament
principal i les seves comprovacions; no obrir deu implementacions simultànies.
No es fixa cap data final: primer cal mesurar dues iteracions i la disponibilitat de comptes,
dispositius i decisions; després, estimar per àrea amb riscos i un interval d'esforç.
Les mides S/M/L són relatives, no equivalències automàtiques en dies.

## Millores visuals i funcionals

Aquesta revisió va inspeccionar codi, documents i tasques; **no és una nova
avaluació visual de l'aplicació renderitzada**. Aquestes propostes s'hauran de verificar
en producció abans de considerar-les lliurades.

| Millora | Responsable | Evidència exigida |
|---|---|---|
| Identitat cobalt/navy coherent, tipografia, icones i estats semàntics | #33 | Catàleg i pantalles reals en clar/fosc; normal, focus, hover, deshabilitat, error; sense halos decoratius ni biblioteca paral·lela |
| Bústia llegible amb selecció inequívoca | #34/#36 | Distingir obert/no llegit/focus/selecció alhora; columnes configurables i persistents; els correus nous no amplien el lot revisat |
| Lectura i redacció centrades en el contingut | #35/#39/#40 | Accions per missatge, HTML ample contingut, adjunts i remitent visibles, esborrany conservat després d'una fallada o un reinici |
| Context útil sense saturar la pantalla | #86 | Agenda, persona i historial de fitxers amb origen/cobertura; plegat, redimensionament i retorn del focus; no barrejar comptes |
| Cerca comprensible | #31/#43/#93 | Filtres equivalents als operadors, vistes desades, origen del resultat i cobertura incompleta diferenciada de zero resultats |
| Configuració i ordres fàcils de trobar | [#149](https://github.com/adilelhaji/oreneta/issues/149) | Cerca ES/EN, accents/Unicode, teclat i context del compte; conservar l'alternativa (fallback) d'altres idiomes i #37 oberta |
| Estat del compte i recuperació visibles | [#150](https://github.com/adilelhaji/oreneta/issues/150) | Fallades simultànies de comptes/serveis, reautenticació i reintent segurs; tancar un avís no equival a resoldre el problema |
| Agenda, persones, tasques i notes coherents | #38/#100–#104 | Un flux real per superfície; no tancar per haver aplicat un tema; diferenciar local, sincronitzat i de només lectura |

Mantenir els contractes de [direcció artística](design/art-direction.md) i
[límits dels panells](design/mail-boundaries.md). La producció fa servir un sol panell per sota de
769 CSS px i navegació completa per sobre de 1024; el fixture històric de
#32 no redefineix aquests límits. Verificar 599/600/601, 768/769, 1024/1025 i 1440,
zoom al 200%, textos llargs i moviment reduït; conservar les preferències existents.

## Com demostrar que millora l'experiència

#32/#55 comparen vuit tasques amb contingut sintètic equivalent a Oreneta i a la
referència estable: (1) configurar un compte i entendre'n les capacitats; (2) localitzar
un correu/adjunt; (3) llegir/respondre; (4) redactar amb un fitxer i recuperar l'esborrany;
(5) arxivar un lot revisat; (6) recuperar-se d'una desconnexió/de permisos;
(7) tramitar una invitació; (8) trobar una opció de configuració i fer-la servir amb el teclat.

Registrar l'èxit, el temps, els errors, l'ajuda necessària, el dispositiu, la versió i els límits
de cada mostra. La comparació automatitzada mesura el comportament repetible;
l'avaluació humana requereix participants autoritzats i no se substitueix pels
temps d'un agent. Definir prèviament cohorts, repeticions i llindars
abans de proclamar una millora; no inventar un guany percentual. A R1 es
comparen els fluxos disponibles en l'abast del candidat: les invitacions continuen
com a mancança explícita de R2 fins a #102. La comparació completa dels vuit fluxos
és una acceptació posterior, no un bloqueig implícit del correu de Windows de R1.

Rendiment: mesurar 1k/10k/100k missatges i calibrar els objectius ja proposats a
#53 (p95: reacció local 100 ms, primera pàgina en memòria cau 500 ms, obertura d'un missatge
baixat 300 ms). No són resultats obtinguts ni compromisos sense dispositiu de
referència. Accessibilitat: teclat, focus, anuncis i zoom en cada lliurament; contrast
segons el contracte vigent i evidència nativa per a les afirmacions de compatibilitat.

## Decisions i dependències que no es poden ocultar

- **Recuperació:** l'opció B es va aprovar el 2026-10-05 i es va registrar a
  l'[ADR-0010](adr/0010-full-profile-local-recovery.md) mitjançant #146. Es conserva
  l'exportació de la configuració i s'hi afegeix una recuperació completa local xifrada.
  El magatzem d'esborranys #169 es va lliurar al PR #174; la integració de l'editor #170,
  la captura #171, la restauració aïllada #172 i la programació/retenció #173 continuen
  pendents. #113 continua oberta; l'aprovació i l'emmagatzematge encara no acrediten
  una còpia completa ni una recuperació nativa.
- **Graph:** direcció aprovada a l'ADR-0004; les accions conserven el consentiment
  incremental i la identitat aïllada. La revocació pot invalidar la lectura i l'escriptura.
  #46 verifica l'exposició real a la retirada d'EWS Online; on-premises és diferent.
  [Guia oficial de Microsoft](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online).
- **OAuth distribuïble:** [#144](https://github.com/adilelhaji/oreneta/issues/144) separa la configuració de desenvolupament i
  la de distribució. Cal revisar els requisits i les excepcions vigents, no suposar un cost
  d'avaluació universal. [Verificació oficial de Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- **Proves per proveïdor:** #98 no ha d'esperar que POP3, la delegació i tots els
  adaptadors estiguin complets per provar les operacions ja disponibles. Cada fila
  requereix la seva operació i un accés autoritzat; el tancament global exigeix totes les files.
- **Windows:** #114 pot comprovar la instal·lació i els fluxos existents abans del tancament
  de #53/#54/#113. L'acceptació final manté el rendiment, la privadesa i la recuperació.
- **Altres models:** perfils, tasques completes, notes, xat i nous contractes
  d'integració/arxiu conserven les seves portes. Aquest pla no decideix cap arquitectura.

## Definició de lliurament i seguiment

Cada slice: requisits reconciliats → documentació/ADR aplicable → codi i
proves → revisió lleugera tècnica i de producte → PR → CI requerida del SHA exacte
→ merge commit → comprovació de main → evidència nativa/de proveïdor aplicable.
Les incidències mare continuen obertes fins que se'n satisfan tots els criteris. Una tasca
de preparació es pot tancar en lliurar el procediment; mai no s'ha de certificar
per això un proveïdor o una plataforma que no s'hagi provat.

#22 manté la matriu d'acceptació, i #21, la seqüència i els bloquejos. Actualitzar
totes dues en tancar cada iteració; declarar per separat implementat, provat amb
fixtures, verificat natiu i verificat amb proveïdor. Les deu tasques noves són
subdivisions de l'abast existent, recollides al manifest; no substitueixen les
65 tasques originals ni redueixen la matriu del producte.

Aquest encàrrec lliura planificació i tasques. No n'inicia per si mateix la implementació,
no publica versions, no modifica comptes/tenants ni contracta serveis. Tota
limitació d'accés, decisió o plataforma continua visible fins que es resol.
