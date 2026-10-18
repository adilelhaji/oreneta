# ADR-0030: Correcció gramatical sense connexió amb Harper

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Dins de l'ADR-0001; sense
  telemetria nova.
- Data: 2026-10-12.
- Abast: #105.

## Decisió

- **Motor:**
  - Harper (`harper.js` 2.10.0, Apache-2.0), el que ja triava l'ADR-0001;
  - s'executa en un worker, des del WebAssembly que va amb l'aplicació
    (uns 16 MB, carregat la primera vegada que es fa servir);
  - cap text no surt de l'equip; una prova e2e falla si en revisar es fa
    qualsevol petició fora de l'aplicació.
- **Idioma:**
  - només anglès (americà, britànic, canadenc i australià), que és el
    que Harper sap;
  - un text que no sembla anglès no es revisa i es diu, en lloc de
    «corregir-lo» amb regles d'un altre idioma.
- **Activació:**
  - desactivada per defecte; la variant d'anglès es tria a Paràmetres;
  - no hi ha LanguageTool ni cap servei remot: l'ADR-0001 el deixa fora
    excepte com a opció explícita per compte, i no s'afegeix aquí.
- **A l'editor:**
  - es revisa després d'una pausa en escriure; una resposta antiga mai no pinta
    sobre text nou;
  - els subratllats són decoracions: no entren a l'esborrany ni al
    missatge enviat;
  - un subratllat segueix el text que es mou i desapareix si canvia el seu
    propi text;
  - res no canvia fins que la persona tria un suggeriment, i això és una
    sola edició que es desfà i conserva el format;
  - «Ignorar» val per a aquesta redacció durant la sessió;
  - més de 20 000 caràcters no es revisen d'una vegada (una resposta amb un
    fil llarg citat), i es diu.
- **Tipus de lletra:** de passada, Inter deixa de demanar-se a Google Fonts i va empaquetat
  (`@fontsource-variable/inter` 5.3.0, OFL-1.1). Obrir l'aplicació ja no
  fa cap petició a tercers.

- **Política de seguretat (CSP):**
  - s'afegeix `'wasm-unsafe-eval'` a `script-src`, que permet compilar
    WebAssembly i no permet `eval` de JavaScript, i `worker-src 'self'
    blob:`, perquè Harper arrenca el seu worker des d'un URL `blob:`;
  - es treuen els hosts de Google Fonts;
  - les proves e2e s'executen ara amb la política exacta de producció
    (`vite preview` la llegeix de `csp_prod.go`); així es va veure que la primera
    versió no hauria funcionat a l'aplicació.

## Alternatives

- LanguageTool en un servidor: més idiomes, però el text surt de l'equip.
- LanguageTool local (Java): pesat i amb un procés a part.
- Només Hunspell: ortografia, no gramàtica; el corrector del sistema ja ho
  cobreix en part.

## Pendent

- L'editor de text pla no té subratllats (un `<textarea>` no admet
  decoracions); fa servir el corrector ortogràfic del sistema.
- Altres idiomes, si Harper els afegeix.
- Diccionari personal que es desi entre sessions.
