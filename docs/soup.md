# Registro SOUP

Componentes de terceros que hacen funciones visibles para la persona
(ADR-0001). Versión fijada, dónde se usan y cómo se comprueban.

| Componente | Versión | Licencia | Dónde | Red | Comprobación |
|---|---|---|---|---|---|
| Harper (`harper.js`) | 2.10.0 | Apache-2.0 | Composer, worker con WebAssembly empaquetado (ADR-0030) | Ninguna | `grammar.test.ts` con el binario real; e2e sin peticiones externas |
| EasyPrivacy | `easylist/easylist@4b79596e` | GPL-3.0+ o CC BY-SA 3.0+ | `meron-core/src/privacy` (ADR-0029) | Solo al actualizar a petición, desde `easylist.to` | Hash en `privacy/README.md`; pruebas del núcleo |
| tokio-xmpp | 6.0.0 con un parche local en `third_party/tokio-xmpp` (#220) | MPL-2.0 | Chat, `meron-core/src/chat/xmpp.rs` (ADR-0036, ADR-0044) | Al servidor XMPP de la cuenta, con su proxy | Pruebas del crate vendorizado en CI, con la del parche; pruebas contra Prosody |
| Inter (`@fontsource-variable/inter`) | 5.3.0 | OFL-1.1 | Fuente de la interfaz, empaquetada | Ninguna | e2e sin peticiones externas |
| Bergamot (`@browsermt/bergamot-translator`) | 0.4.9 | MPL-2.0 | Lector y composer, worker con WebAssembly empaquetado (ADR-0031) | Ninguna | `build-tests/bergamot.check.mjs` y e2e con el modelo real |
| Modelos de traducción de Mozilla | registro `bergamot-models-sandbox/0.3.3` (19 pares de producción), copiado sin cambios al release `translation-models-0.3.3` de este repositorio | MPL-2.0 | `meron-core/src/translation`; copia con `scripts/translation-models/mirror.py` | Solo al descargar un idioma a petición, desde `github.com` | SHA-256 de cada archivo en el núcleo y otra vez al cargarlo |
