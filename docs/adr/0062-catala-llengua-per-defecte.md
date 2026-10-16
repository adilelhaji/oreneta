# ADR-0062: El català, llengua de la interfície per defecte

- Estat: Acceptada per delegació (el propietari va delegar les decisions de
  disseny de #231 en l'opció més prudent); pendent de revisió del propietari.
- Data: 2026-10-16.
- Abast: #231, filla de #37. La llengua principal d'Oreneta és el català
  (decisió del propietari del 2026-10-16). La traducció de `docs/` és #232 i
  en queda fora.

## Context

El catàleg tenia 19 llengües i cap era el català. Un perfil sense cap tria
seguia la llengua del sistema, i triar «Sistema» al selector desava `null`,
el mateix que no haver triat mai: les dues coses no es podien distingir.

## Decisió

- **Català per defecte.** `locales/ca.json` té les mateixes claus i els
  mateixos marcadors que `en.json`. Un perfil que no ha triat mai cap
  llengua (sense fila `language`) mostra la interfície en català, sigui
  quina sigui la llengua del sistema. Aquest valor per defecte no es desa:
  no compta com a tria.
- **Una fila sempre és una tria, i guanya.** Una llengua del catàleg es
  manté. «Sistema» es desa ara com a `"system"` i segueix la llengua del
  sistema (en anglès, la llengua d'origen del catàleg, si el sistema en parla
  una que el catàleg no té). El `null` que desava «Sistema» abans d'aquesta
  decisió, o una llengua que aquesta versió no té (escrita per una de més
  nova), també segueixen el sistema. La regla és a
  `languageChoiceFromStore` i `resolveInterfaceLanguage`
  (`frontend/src/lib/i18n.ts`).
- **El selector** mostra «Català» marcat mentre ningú no ha triat, perquè és
  la llengua en ús.
- **Abans de llegir la tria** (l'arrencada, abans que respongui
  `app.prefsGet`) la interfície es pinta en la llengua que va mostrar l'última
  sessió (la memòria cau de pintat de `settings.ts`), o en català en un perfil
  nou. Així una persona que ha triat el castellà no veu el català un instant,
  i les etiquetes natives que se'n deriven (#225) surten en la seva llengua.
- **Dates i hores** segueixen la llengua de la interfície a tot arreu
  (`intlLocale()`), com ja feien el calendari i l'agenda. Abans, la llista de
  correu i altres pantalles feien servir la configuració regional del
  sistema, i una interfície en català en un sistema anglès hauria mostrat
  els mesos en anglès. Queden fora: el primer dia de la setmana, que
  continua seguint la regió del sistema (ADR-0051), i el marcador `{date}`
  de les plantilles, que és text que s'envia a altres persones.
- **Etiquetes natives de Go** (safata del sistema i notificacions): les envia
  el frontend en la llengua de la interfície, com fins ara. Els valors per
  defecte de Go continuen en anglès fins que arriben.
- **Mòbil:** el català s'afegeix al catàleg generat (Android i iOS), a
  `locales_config.xml`, a les regions d'Xcode i al selector. El mòbil
  continua seguint la llengua del sistema i la tria per aplicació d'Android
  13 o posterior; fer-lo començar en català queda fora d'aquesta decisió.
- **Guardià de l'apòstrof:** en ICU, un apòstrof just davant de `{`, `}`,
  `#`, `|` o `<` obre un literal i el marcador es mostraria com a text. La
  validació del catàleg ho rebutja en totes les llengües; en català no
  s'apostrofa davant d'un marcador («de {name}»).

## Conseqüències

- Un perfil existent que no havia triat mai cap llengua passa al català en
  actualitzar. Qui havia triat «Sistema» o una llengua la conserva.
- Si `app.prefsGet` falla en arrencar, el perfil es tracta com a nou i es
  mostra en català fins a la pròxima arrencada correcta.
- Proves: `scripts/i18n/catalog.test.ts` (20 llengües i validació real),
  `frontend/src/lib/i18n.test.ts` i `frontend/src/states/interfaceLanguage.test.ts`
  (perfil nou, tria desada, canvi de llengua, dates), `notify_catalan_test.go`
  (etiquetes natives i notificacions en català) i les comprovacions de
  `frontend/e2e/startup.e2e.ts` en català a 600, 1024 i 1440 px, clar i fosc,
  al 200 % i amb axe.
