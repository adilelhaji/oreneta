# Proves d'escriptori multiplataforma

Incidència #76: les proves del sistema de fitxers no han de fer servir mai un perfil
d'usuari real. El fixture de proves compartit defineix `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, redirigeix els camins XDG de dades,
d'estat i d'execució, i neteja les substitucions heretades de configuració/memòria cau
XDG i de perfil de desenvolupament. Cada prova obté arrels temporals separades de
configuració i de memòria cau segons la convenció del sistema operatiu amfitrió. Les
proves de mitjans, avatar, fons de pantalla, actualitzador i sidecar fan servir aquest
fixture. La selecció de camins de producció no canvia.
Els fixtures d'entorn no s'han d'executar amb `t.Parallel()`.

Les assercions XDG s'apliquen a Linux; Windows/macOS han de conservar les seves
convencions natives de directoris fins i tot quan hi ha substitucions XDG. Els fixtures
de canal d'actualització d'un altre sistema operatiu esperen camins normalitzats per
l'API del sistema de fitxers amfitrió. La cobertura d'enllaços simbòlics només s'omet
per a l'error 1314 de Windows (manca del privilegi d'enllaç simbòlic), mai per a altres
errors.

La CI executa la suite completa de Go a Windows, a més de Linux. La porta de qualitat de
publicació requereix el job `go-windows` sobre el commit exacte de main. L'inici i el
reinici de l'executable natiu continuen sent comprovacions separades de la compilació de
publicació, documentades a [inici a l'escriptori](desktop-startup.md).
