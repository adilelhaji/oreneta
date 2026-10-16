# Instal·lació d'actualitzacions: verificació i reversió (#147)

Part de #147 que es pot comprovar fora de Windows. La instal·lació,
l'actualització i la desinstal·lació reals en un Windows net continuen pendents
de proves natives.

## Què es corregeix

- **Verificació abans d'instal·lar.** L'SHA-256 i la mida es comprovaven
  només en acabar la baixada. Després el paquet esperava a la memòria cau
  d'actualitzacions, on qualsevol procés de l'usuari podia escriure, fins que la
  persona premia instal·la. Ara es tornen a comprovar just abans de
  substituir l'aplicació. Si el paquet ha canviat, s'ha ampliat o ha
  desaparegut:
  - es descarta;
  - l'actualització es torna a oferir per baixar-la, amb el motiu;
  - l'aplicació instal·lada no es toca.
- **Executable portable de Windows.** La substitució ara és a
  `update_portable.go`, sense etiqueta de plataforma. Només `applyUpdate` i el
  rellançament continuen sent de Windows. Abans de moure res:
  - es rebutja un fitxer que no és zip;
  - es rebutja un zip sense `oreneta.exe`;
  - es rebutja una entrada que no comença per la capçalera `MZ`;
  - es rebutja una entrada més gran que el límit d'actualització (512 MiB),
    tant per la mida declarada com pel que realment s'ha llegit.
- **Reversió.** Si l'executable nou no pot ocupar el seu lloc, es
  restaura l'anterior. Si tampoc no es pot restaurar, l'error diu on ha
  quedat.

## Proves (qualsevol plataforma)

- `TestUpdaterInstallRejectsAPayloadChangedAfterDownload` cobreix un paquet
  alterat amb la mateixa mida, un d'ampliat i un d'esborrat. Falla sense la
  correcció: el paquet alterat s'instal·lava.
- `TestReplaceExecutableRefusesABadArchive` cobreix un fitxer que no és zip, un
  zip sense executable, un executable que no és de Windows i una entrada buida.
  En els quatre casos l'instal·lat continua igual i no queda res al costat.
- `TestReplaceExecutableSwapsInTheNewCopy` comprova que la còpia anterior
  queda com a `.old` per a l'escombrada en arrencar.
- `TestReplaceExecutableRestoresThePreviousCopyWhenTheSwapFails` simula una
  fallada del segon canvi de nom.

## Pendent (Windows natiu)

- Instal·lar, actualitzar des de la versió anterior i desinstal·lar en un sistema
  net.
- Executable bloquejat per un altre procés.
- Rellançament després de l'actualització.
- Instal·lador NSIS en mode silenciós amb UAC.
- Què conserva la desinstal·lació: el perfil a `%APPDATA%` i les dades de WebView2.
