# ADR-0062: El català, llengua de la interfície per defecte

- Estat: Acceptada per delegació (el propietari va delegar les decisions de
  disseny de #231 en l'opció més prudent). El comportament en actualitzar i
  l'abast només d'escriptori són decisions del propietari del 2026-10-16.
- Data: 2026-10-16.
- Abast: #231, filla de #37, només l'aplicació d'escriptori. La llengua
  principal d'Oreneta és el català (decisió del propietari del 2026-10-16).
  La traducció de `docs/` és #232; el mòbil és #240.

## Context

El catàleg tenia 19 llengües i cap era el català. Un perfil sense cap tria
seguia la llengua del sistema, i triar «Sistema» al selector desava `null`,
el mateix que no haver triat mai: les dues coses no es podien distingir.

## Decisió

- **Català per defecte a l'escriptori.** `locales/ca.json` té les mateixes
  claus i els mateixos marcadors que `en.json`. Un perfil que no ha triat mai
  cap llengua (sense fila `language`) mostra la interfície en català, sigui
  quina sigui la llengua del sistema. Aquest valor per defecte no es desa:
  no compta com a tria.
- **Una fila sempre és una tria, i guanya.** Una llengua del catàleg es
  manté. «Sistema» es desa ara com a `"system"` i pren la primera de les
  llengües preferides del sistema que el catàleg té (en anglès, la llengua
  d'origen del catàleg, si no en té cap). El `null` que desava «Sistema»
  abans d'aquesta decisió, o una llengua que aquesta versió no té (escrita
  per una de més nova), també segueixen el sistema. La regla és a
  `languageChoiceFromStore` i `resolveInterfaceLanguage`
  (`frontend/src/lib/i18n.ts`).
- **En actualitzar** (decisió del propietari): un perfil que no havia triat
  mai cap llengua passa al català; qui havia triat una llengua, o «Sistema»
  (el `null` desat abans), la conserva.
- **El selector** mostra «Català» marcat mentre ningú no ha triat, perquè és
  la llengua en ús.
- **Abans de llegir la tria** (l'arrencada, abans que respongui
  `app.prefsGet`) la interfície es pinta en la llengua que va mostrar l'última
  sessió (la memòria cau de pintat de `settings.ts`, `readPaintLanguage`), o
  en català en un perfil nou. Les cadenes ja hi són en el primer render, no
  només després d'un efecte. Així una persona que ha triat el castellà no veu
  ni el català ni l'anglès un instant, i les etiquetes natives que se'n
  deriven (#225) surten en la seva llengua. La memòria cau només es reescriu
  quan la tria es coneix.
- **Una lectura fallida no és un perfil nou.** Si `app.prefsGet` falla, la
  llengua no es toca: en arrencar es queda la de pintat i en una nova
  arrencada (afegir un compte, restaurar un arxiu) la tria que ja es tenia.
- **Dates i hores de la interfície** segueixen la llengua de la interfície
  (`intlLocale()`), com ja feien el calendari i l'agenda. Quan la
  configuració regional preferida del sistema és d'aquesta mateixa llengua
  (en-GB per a una interfície en anglès, es-MX, pt-PT, de-CH…), se'n fa
  servir la forma completa, que conserva l'ordre i els formats de la regió;
  si no (una interfície en català en un sistema anglès), la de la llengua de
  la interfície. Abans, la llista de correu i altres pantalles feien servir
  sempre la configuració regional del sistema.
- **El text que surt de l'aplicació no canvia amb la llengua de la
  interfície:** la data de la capçalera d'un missatge reenviat i el marcador
  `{date}` de les plantilles continuen amb la configuració regional del
  sistema. El primer dia de la setmana continua seguint la regió del sistema
  (ADR-0051).
- **Etiquetes natives de Go** (safata del sistema i notificacions): les envia
  el frontend en la llengua de la interfície, com fins ara. Els valors per
  defecte de Go continuen en anglès fins que arriben. Un recordatori donat un
  dia posterior al de l'inici de l'esdeveniment té una frase pròpia amb la
  data (`notify.reminderStartedOn`, «Ha començat el {date} a les {time}»).
- **Mòbil:** el català s'afegeix al catàleg generat (Android i iOS), a
  `locales_config.xml`, a les regions d'Xcode i al selector. El mòbil
  continua seguint la llengua del sistema i la tria per aplicació d'Android
  13 o posterior; fer-lo començar en català és #240.
- **Guardià de l'apòstrof:** en ICU, un apòstrof just davant de `{`, `}`,
  `#`, `|`, `<` o `>` obre un literal i el marcador es mostraria com a text.
  La validació del catàleg ho rebutja en totes les llengües; en català no
  s'apostrofa davant d'un marcador («de {name}»).

## Conseqüències

- Els recomptes sense plural que l'anglès ja té («1 hores», «1 regles»)
  surten igual en català i en les altres llengües; se'n fa càrrec #241.
- Proves: `scripts/i18n/catalog.test.ts` (20 llengües i validació real),
  `frontend/src/lib/i18n.test.ts` i `frontend/src/states/interfaceLanguage.test.ts`
  (perfil nou, tria desada, canvi de llengua, lectura fallida, dates),
  `notify_catalan_test.go` (etiquetes natives i notificacions) i les
  comprovacions de `frontend/e2e/startup.e2e.ts` en català a 600, 1024 i
  1440 px, clar i fosc, al 200 % i amb axe.
