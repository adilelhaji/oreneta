# Traducció sense connexió (#106)

Registre de la implementació de l'ADR-0031.

## Peces

- **Nucli:**
  - `meron-core/src/translation/` té el registre fix, la ruta (directa
    o passant per l'anglès), l'estat, la baixada comprovada i atòmica, la quota i
    la neteja en arrencar;
  - RPC `translation.status/download/cancel/remove`;
  - esdeveniments `translation.progress` i `translation.done`; l'error porta un
    codi (`cancelled`, `quota`, `diskFull`, `integrity`, `network`,
    `disk`).
- **Pont Go:** `MERON_MODELS_DIR` (memòria cau de la instal·lació) i `/models/`,
  que no serveix carpetes que comencen per punt.
- **Aplicació:**
  - `lib/translation.ts`: client del worker, comprovació de resums (hash),
    deducció de l'idioma i traductor (una petició cada vegada, aturada);
  - `states/translation.ts`: baixades amb consentiment i traduccions per
    missatge;
  - `TranslationNotice`, `TranslateDraftDialog` i el grup de Configuració
    «Traducció».

## Proves

- **N1, nucli:** fitxer malmès, més llarg del que s'ha publicat, tall,
  cancel·lació, quota, restes en arrencar, rutes i registre amb camins de
  fitxer.
- **N1, aplicació:** ruta, deducció de l'idioma, comprovació de resums,
  traductor, lector (triar idiomes, mostrar i veure l'original, baixada
  rebutjada o acceptada, error d'integritat, parell sense model) i diàleg
  d'esborrany (no canvia res fins que es tria; HTML amb format).
- **Motor real:** `build-tests/bergamot.check.mjs` arrenca el worker i el
  WebAssembly que es distribueixen i tradueix del castellà a l'anglès amb el model
  publicat. La CI el baixa amb `scripts/fetch-translation-test-model.mjs`,
  comprovat amb el registre i desat a la memòria cau.
- **N3 e2e:** a Chromium i amb la CSP de producció, un esborrany es tradueix
  amb el Bergamot real, es revisa i s'afegeix a sota; no hi ha cap
  petició fora de l'aplicació.
