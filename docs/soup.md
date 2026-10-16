# Registre SOUP

Components de tercers que fan funcions visibles per a la persona
(ADR-0001). Versió fixada, on es fan servir i com es comproven.

| Component | Versió | Llicència | On | Xarxa | Comprovació |
|---|---|---|---|---|---|
| Harper (`harper.js`) | 2.10.0 | Apache-2.0 | Composer, worker amb WebAssembly empaquetat (ADR-0030) | Cap | `grammar.test.ts` amb el binari real; e2e sense peticions externes |
| EasyPrivacy | `easylist/easylist@4b79596e` | GPL-3.0+ o CC BY-SA 3.0+ | `meron-core/src/privacy` (ADR-0029) | Només en actualitzar a petició, des de `easylist.to` | Resum (hash) a `privacy/README.md`; proves del nucli |
| Inter (`@fontsource-variable/inter`) | 5.3.0 | OFL-1.1 | Tipus de lletra de la interfície, empaquetat | Cap | e2e sense peticions externes |
| Bergamot (`@browsermt/bergamot-translator`) | 0.4.9 | MPL-2.0 | Lector i composer, worker amb WebAssembly empaquetat (ADR-0031) | Cap | `build-tests/bergamot.check.mjs` i e2e amb el model real |
| Models de traducció de Mozilla | registre `bergamot-models-sandbox/0.3.3` (19 parells de producció), copiat sense canvis a la versió publicada (release) `translation-models-0.3.3` d'aquest repositori | MPL-2.0 | `meron-core/src/translation`; còpia amb `scripts/translation-models/mirror.py` | Només en baixar un idioma a petició, des de `github.com` | SHA-256 de cada fitxer al nucli i un altre cop en carregar-lo |
