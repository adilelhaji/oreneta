# Verificació de l'inici a l'escriptori

L'entrada de producció (`src/main.tsx` → `App` → `boot`) s'ha de renderitzar en un
navegador després de `bun run build`. Les proves de components i la línia base visual
sintètica no exerceixen aquest contracte i no poden certificar que una finestra
empaquetada s'iniciï.

La incidència #75 reprodueix una fallada d'inici a Windows amb `useSyncExternalStore`
sobre un dispatcher de React nul. Una instal·lació mixta de dependències va resoldre
React 19.2.6 per a l'aplicació i React 19.2.8 per al paquet enllaçat dins el mateix
paquet de producció. Mantingueu React i React DOM com a instàncies úniques (singletons)
mitjançant el contracte documentat `resolve.dedupe` de Vite; no cal actualitzar ni
substituir l'arquitectura d'estat de l'aplicació.

Feu servir Bun 1.4.2 i els fitxers de bloqueig (lockfiles) registrats al repositori.
Wails instal·la amb `bun install --frozen-lockfile`; no hi superposeu l'arbre de
dependències enllaçades d'un altre gestor de paquets. Substituïu un arbre
`node_modules` mixt per una instal·lació nova i bloquejada. Això també evita còpies
obsoletes de dependències peer de Tiptap/ProseMirror.

El job de frontend de la CI (integració contínua) executa `bun run test:bundler`
(resolució de producció amb un duplicat enllaçat deliberat) i `bun run startup:verify`
(compilació més navegador). Les traces i les captures de pantalla de l'inici es pugen
al costat de les evidències de la línia base.

L'executor de les proves de fum de producció serveix els recursos compilats reals per
la interfície de bucle local (loopback). Només la prova injecta un transport Wails, amb
respostes sintètiques explícites i rebuig de les ordres desconegudes. L'aplicació no
inclou cap transport simulat ni cap entrada de prova. Les proves han de comprovar els
errors de consola, la configuració inicial (onboarding), la recàrrega i la navegació
amb un compte sintètic en pausa; no hi intervé cap inici de sessió de proveïdor, cap
transmissió de correu ni cap dada real d'usuari.

Aquesta comprovació al navegador complementa la línia base aïllada de components. La
verificació nativa a Windows, a més, inicia l'executable empaquetat amb un perfil
temporal i n'inspecciona la interfície renderitzada per WebView2. Chromium sol no
certifica l'entorn d'execució de Wails, el clauer, la interoperabilitat amb proveïdors
ni el comportament de l'instal·lador.

La compilació de publicació per a Windows executa `scripts/test-windows-startup.ps1`
abans de l'empaquetament/publicació. Dos llançaments reutilitzen un perfil temporal
sota la identitat d'instància única de desenvolupament existent. Windows UI Automation
ha de trobar els controls reals de configuració inicial; cada llançament ha de
registrar per separat l'inici del nucli incrustat i una consulta de comptes correcta.
Les evidències es pugen fins i tot en cas de fallada. No s'utilitza cap substitució
del depurador, cap compte real ni cap perfil de producció. Això no prova cap
actualització de l'instal·lador ni l'autenticació amb proveïdors.
Els registres nativs continuen sent evidència de la CI; la publicació de la versió
només baixa els artefactes distribuïbles `oreneta-*`.

Per a les compilacions que no es publiquen, feu servir la
[canalització de validació de Windows](windows-validation-artifacts.md) separada. A
més, requereix l'opció de configuració inicial de Graph; l'inici de sessió amb
proveïdors continua sense provar-se.

Referències: [diagnosi de l'entorn d'execució de React duplicat](https://react.dev/warnings/invalid-hook-call-warning#duplicate-react),
[deduplicació de dependències de Vite](https://vite.dev/config/shared-options.html#resolve-dedupe).
