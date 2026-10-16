# Gramàtica sense connexió (#105)

Registre de la implementació de l'ADR-0030.

## Peces

- `frontend/src/lib/grammar.ts`: `GrammarChecker` (una revisió alhora,
  `stale` per a la que queda avançada, límit de mida, idioma, ignorats)
  i l'adaptador sobre Harper (`engineFrom`, `harperEngine`).
- `frontend/src/components/composer/grammarExtension.ts`: el document com a
  text amb el seu mapa de posicions, col·locació dels problemes, decoracions que
  segueixen el text i aplicació d'un suggeriment com una sola transacció.
- `GrammarPopover.tsx`: suggeriments, «Ignora» i l'estat (no revisat per
  l'idioma, massa llarg, no s'ha pogut carregar).
- Opció de configuració `grammarCheck` (`grammar_check`), desactivada per defecte.

## Proves

- N1 amb el Harper real (el mateix WebAssembly): troba «I has», a la
  posició correcta encara que hi hagi emojis, i no revisa un text en castellà.
- N1 de l'editor: mapa de posicions, edició única que es desfà i
  conserva el format, subratllats que es mouen o es descarten.
- N3 e2e: activar-ho a Configuració, escriure, triar el suggeriment i comprovar
  que no hi ha hagut cap petició fora de l'aplicació. Aquesta comprovació va
  trobar que la font es demanava a Google Fonts; ara va empaquetada.
