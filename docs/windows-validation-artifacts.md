# Artefactes de validació de Windows (#131)

Filla de #114. Compilar l'aplicació Wails/Rust existent per a Windows amd64;
cap canvi d'arquitectura, de signatura ni de canal d'actualització. No llançar `release.yml`
per a la validació: la seva via manual també publica una versió pública.

`windows-validation.yml` és una compilació explícita només de CI amb permisos de
repositori de només lectura. Fa el checkout (còpia de treball) del SHA del llançament, exigeix que la seva CI de main de set jobs (tasques de CI)
s'hagi completat mitjançant la política de porta de publicació existent (sense requisit d'etiqueta de git) i després
compila les dependències bloquejades de Rust/Bun, el sidecar incrustat i l'instal·lador NSIS.
No substituir mai el commit comprovat per un checkout més nou de la branca.

La prova nativa aïllada existent d'arrencada/reinici ha de passar i trobar l'opció de compte
Graph. No es fa servir cap inici de sessió, bústia real ni perfil d'usuari existent.
Pujar els diagnòstics fins i tot en cas de fallada; pujar els canònics `oreneta.exe` i
`oreneta-amd64-installer.exe` només després que la validació nativa tingui èxit. Un manifest JSON
vincula els dos resums SHA256 al SHA complet del codi font i a l'execució del flux de treball.

Aquest procés crea artefactes de CI, mai etiquetes de git, versions publicades, manifests de l'actualitzador ni
enviaments a botigues. No certifica la interoperabilitat amb proveïdors de comptes,
l'actualització/desinstal·lació de l'instal·lador, la signatura, altres arquitectures ni la paritat amb eM Client.
Després de la baixada, verificar els dos resums i el SHA del codi font abans de substituir la sortida local.
Retirar a la Paperera de reciclatge només els binaris d'aplicació substituïts, després d'una verificació
correcta de la substitució; ajornar els fitxers bloquejats i les sessions no desades. Mantenir l'evidència
separada del directori canònic de binaris.

Les proves automatitzades de la política cobreixen l'execució només per llançament manual, el checkout/porta exactes,
els permisos de només lectura, les compilacions bloquejades, l'ordre de la validació nativa abans de l'artefacte,
l'evidència de fallades i l'absència de publicació. La CI i la compilació nativa llançada
són evidències obligatòries separades; una definició de flux de treball per si sola no és un
executable validat.

El candidat del 2026-10-06 (execució 37426555798) va representar la incorporació i va iniciar el
motor incrustat, però va fallar la comprovació de zoom abans d'enviar Ctrl+0. La seva unió INPUT de C#
ometia MOUSEINPUT, cosa que produïa una estructura de 32 bytes en lloc de l'ABI de 40 bytes
de Win64. Cal mantenir els tres membres de la unió Win32. La CI de Windows de main executa
`scripts/test-windows-startup.ps1 -ValidateInputLayout` per comprovar la mida
serialitzada i el desplaçament de la unió sense llançar cap aplicació ni enviar entrada. Les comprovacions
d'arrencada/reinici empaquetades i la de zoom real continuen sent obligatòries.
Vegeu la [definició d'INPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input) de Microsoft.

L'execució 37429870187 va confirmar després que Wails desactiva les dreceres de teclat
del navegador. L'acceptació del zoom natiu fa servir Ctrl+roda, amb l'ampliació i la
restauració mesurades en tots dos llançaments; vegeu [límits del correu](design/mail-boundaries.md).
Les memòries cau de dependències de Rust es conserven si una comprovació nativa posterior falla, cosa que evita
recompilar totes les dependències durant el diagnòstic. Això no puja binaris d'aplicació
fallits ni relaxa la porta d'artefactes de CI/nativa de codi font exacte.

L'execució 37434499697 va arribar al zoom natiu però va trobar l'editor fora de la part visible
del formulari desplaçable. Ara la comprovació exercita l'accessibilitat per Tab/Maj+Tab
abans de comprovar el focus, els límits complets de l'editor, el creixement i la restauració. Registra
la geometria d'accessibilitat prèvia al desplaçament fins i tot en cas de fallada. Una prova de regressió del navegador
de 410x280 píxels CSS cobreix la mateixa ruta de teclat i totes les opcions de proveïdor; no
substitueix l'execució nativa obligatòria del candidat.
