# Registres OAuth: inventari i configuracions (#144)

Amb data 2026-10-10. No conté credencials: els noms de variable i els
àmbits basten per revisar-lo.

## Inventari

| Client | On és | Propietari | Àmbits |
|---|---|---|---|
| Google (Gmail, Calendar, Contactes) | `oauth_inherited.go`, ofuscat | Meron (Nonbili), heretat de la bifurcació | `https://mail.google.com/` (restringit), `userinfo.email` i `userinfo.profile`, `calendar` i `contacts.readonly` (sensibles) |
| Microsoft (Outlook IMAP/SMTP i Microsoft Graph) | `oauth_inherited.go`, ofuscat | No consta que sigui d'Oreneta: va arribar amb la bifurcació, sense historial propi | IMAP/SMTP: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid email profile`. Graph: `Mail.Read`; i, només si es demanen a part (ADR-0004), `Mail.ReadWrite` i `Mail.Send` |
| Google o Microsoft propis d'Oreneta | — | Encara no existeixen | — |

El responsable ha de confirmar a qui pertany el client de Microsoft. Fins
aleshores es tracta com a no propi.

## Configuracions

### Desenvolupament intern (compilació per defecte)

- Compila els valors heretats d'`oauth_inherited.go`
  (`//go:build !distributable`).
- Per a Google, `MERON_GOOGLE_CLIENT_ID` i `MERON_GOOGLE_CLIENT_SECRET` a
  l'entorn tenen prioritat. Microsoft només pren el valor compilat, per la
  decisió que fixa `TestGoogleOAuthTakesCredentialsFromEnvironment`.
- No s'ha de distribuir: fa servir registres que no són d'Oreneta.

### Distribuïble (`-tags distributable`)

- No compila cap valor heretat (`oauth_distributable.go`).
- Els valors propis s'injecten en compilar, ofuscats amb
  `go run ./cmd/obfuscate`:

  ```sh
  wails build -tags "distributable …" -ldflags "-X main.googleClientIDObf=… -X main.googleClientSecretObf=… -X main.outlookClientIDObf=…"
  ```

- Sense un valor, o amb un de mal format, aquest inici de sessió no està disponible:
  - l'assistent desactiva el botó i explica les alternatives;
  - Microsoft Graph s'hi nega abans d'obrir el navegador;
  - el nucli no rep cap client i un compte OAuth que hagi de renovar
    el testimoni diu que l'inici de sessió no està disponible en aquesta
    compilació i proposa afegir la bústia amb contrasenya.
- IMAP/SMTP amb contrasenya, Exchange (EWS) i les subscripcions de calendari
  no depenen de res d'això.
- `release.yml` encara no compila amb `distributable`. Activar-ho deixa les
  versions publicades sense inici de sessió amb Google ni Microsoft fins que
  existeixin registres propis. És decisió del responsable, juntament amb crear
  aquests registres.

### Forma vàlida

Un valor amb una altra forma compta com a absent, en les dues compilacions:
- Google: `<número>-<id>.apps.googleusercontent.com`;
- secret: sense espais i de 256 caràcters com a màxim;
- Microsoft: un GUID.

L'entorn que es passa al nucli només porta els valors acceptats. Abans copiava
les variables del procés tal qual, de manera que el nucli podia renovar testimonis
amb un client que l'inici de sessió havia rebutjat, o amb un
`MERON_OUTLOOK_CLIENT_ID` que Go ignora expressament.

## Requisits de Google

- **El que s'ha comprovat.** Comprovat el 2026-10-10 sobre el text de
  [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
  (aquesta sessió no va poder obrir la pàgina, només el seu text indexat):
  - els àmbits de Gmail, inclòs l'ús per IMAP/SMTP, són restringits;
  - una aplicació que desa o transmet dades d'àmbits restringits en servidors
    necessita una avaluació de seguretat;
  - les excepcions publicades a la verificació són: ús personal, entorns
    de desenvolupament, només dades pròpies del servei, ús intern d'una
    organització i instal·lació en tot un domini.
- **Pendent de confirmar.** Oreneta desa el correu només al dispositiu.
  No he confirmat a la documentació oficial si això eximeix de l'avaluació;
  només hi ha indicis de tercers. El responsable ho ha de confirmar abans de
  decidir. No s'ha assumit que calgui una avaluació de pagament ni que no
  calgui.
- **Bloquejat fins a autorització expressa:** crear registres, enviar a
  verificació o pagar una avaluació.

## Proves

- **Go, ambdues compilacions** (`oauth_config_test.go`): els valors mal
  formats no compten com a configurats, l'inici de sessió els rebutja i no
  arriben al nucli.
- **Go, desenvolupament** (`oauth_inherited_test.go`): l'entorn mana per a Google,
  es fan servir els valors compilats si no hi ha entorn, i el nucli rep només el
  client de Microsoft de la compilació.
- **Go, distribuïble** (`oauth_distributable_test.go`):
  - sense valors injectats es deneguen Gmail, Outlook, l'intercanvi de codi i
    Graph, i el nucli no rep res;
  - amb valors injectats es fan servir aquests.
- **Rust** (`engine::tests::refresh_fails_closed_without_an_oauth_client`):
  - sense client, també amb una variable buida, la renovació s'atura amb
    el motiu;
  - prioritat: el del compte, després el de l'amfitrió, després el de l'entorn.
- **CI** (job `go`):
  - compila el binari distribuïble;
  - `scripts/ci/inherited-oauth.cjs` comprova que no conté cap dels
    valors d'`oauth_inherited.go` i informa només dels noms;
  - comprovat a mà en les dues direccions: el binari de desenvolupament es
    detecta i el distribuïble no.
