# Plataformes d'escriptori: Linux i macOS (#115)

El que es comprova a cada plataforma, i el que no.

- **Comprovació:** `scripts/test-desktop-startup.sh` obre dues vegades el
  binari de producció en un perfil nou. A cada arrencada espera dues coses al
  registre:
  - que el nucli s'hagi iniciat;
  - que l'aplicació React dins del webview li hagi fet les primeres crides,
    amb la CSP de producció.

  Desa una captura i el registre de cada arrencada. Falla si el nucli no
  s'inicia o si l'aplicació mostra la pantalla d'error.
- **Linux:** WebKitGTK 4.1 sota Xvfb, a la tasca (job) `linux-native` de la CI.
  També passa en local.
- **macOS:** WKWebView a l'executor allotjat de GitHub, a la tasca
  `macos-native`. El repositori és públic, de manera que aquests minuts no
  costen res.

## El que no cobreix

Arrencar no és paritat. A macOS continuen sense evidència:

- el clauer del sistema (la comprovació fa servir `MERON_KEYRING=off`);
- les notificacions;
- la impressió;
- els mètodes d'entrada (IME);
- la instal·lació signada i l'actualització;
- un flux de correu amb un compte real.

Aquesta evidència necessita un Mac amb sessió d'usuari, la signatura i la
notarització d'Apple i comptes de prova. Tot això depèn del propietari, igual
que la verificació nativa de Windows. Linux continua sent una plataforma amb proves de regressió; el seu resultat no demostra res sobre la paritat a macOS
o a Windows.

## Identitats de signatura d'Apple (pendent de decisió, #249)

Les identitats de signatura de macOS encara porten el nom de Nonbili Inc. No
es canvien fins que el propietari decideixi quin compte de desenvolupador
d'Apple signarà les versions. El nom d'una identitat és el del titular del
compte que emet el certificat; per tant, no es pot triar lliurement.

Llocs que caldria canviar:

- `.github/workflows/release.yml`, pas `package macOS dmg`:
  `Developer ID Application: Nonbili Inc. ($TEAM_ID)`, dues vegades (l'app i
  el DMG).
- `scripts/build-mas.sh`: els valors per defecte
  `Apple Distribution: Nonbili Inc. ($TEAM_ID)` i
  `3rd Party Mac Developer Installer: Nonbili Inc. ($TEAM_ID)`. Les variables
  `MAS_APP_IDENTITY` i `MAS_INSTALLER_IDENTITY` ja els substitueixen sense
  tocar el codi.

Amb el compte també canvien els secrets que hi van lligats:

- signatura: `CSC_LINK` i `CSC_KEY_PASSWORD` (el certificat que el flux de
  treball importa al clauer) i `APPLE_TEAM_ID`;
- notarització: `APPLE_ID` i `APPLE_APP_SPECIFIC_PASSWORD`;
- App Store: `APP_STORE_DEVELOPMENT_TEAM` i el perfil de provisió
  (`MAS_PROVISION_PROFILE`), que ha de ser del mateix equip.
