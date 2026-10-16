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
- **Linux:** WebKitGTK 4.1 sota Xvfb, a la tasca `linux-native` de la CI.
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
que la verificació nativa de Windows. Linux continua sent una plataforma amb
regressió comprovada; el seu resultat no demostra res sobre la paritat a macOS
o a Windows.
