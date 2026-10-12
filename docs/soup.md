# Registro SOUP

Componentes de terceros que hacen funciones visibles para la persona
(ADR-0001). Versión fijada, dónde se usan y cómo se comprueban.

| Componente | Versión | Licencia | Dónde | Red | Comprobación |
|---|---|---|---|---|---|
| Harper (`harper.js`) | 2.10.0 | Apache-2.0 | Composer, worker con WebAssembly empaquetado (ADR-0030) | Ninguna | `grammar.test.ts` con el binario real; e2e sin peticiones externas |
| EasyPrivacy | `easylist/easylist@4b79596e` | GPL-3.0+ o CC BY-SA 3.0+ | `meron-core/src/privacy` (ADR-0029) | Solo al actualizar a petición, desde `easylist.to` | Hash en `privacy/README.md`; pruebas del núcleo |
| Inter (`@fontsource-variable/inter`) | 5.3.0 | OFL-1.1 | Fuente de la interfaz, empaquetada | Ninguna | e2e sin peticiones externas |
