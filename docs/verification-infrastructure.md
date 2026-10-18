# Infraestructura de verificació (iteració 0)

Lliuraments de la iteració 0 del [pla de finalització](completion-plan-2026-10-09.md),
que preparen les proves que necessiten les iteracions següents. Cap
d'ells certifica un proveïdor real ni l'aplicació nativa; declaren què mesuren
i on acaba la seva evidència.

## Cobertura mesurada en cada execució de CI

| Capa | Ordre a `test.yml` | Artefacte |
|---|---|---|
| Go | `go test -tags webkit2_41 -coverprofile=coverage/go.out ./...` i `go tool cover -func` | `coverage-go-<sha>` (perfil i resum) |
| Rust | `cargo llvm-cov --lcov` sobre `meron-core` i `cargo llvm-cov report --summary-only` | `coverage-rust-<sha>` (lcov i resum) |
| Frontend | `bun test --coverage --coverage-reporter=lcov --coverage-reporter=text` | `coverage-frontend-<sha>` (lcov) |

Les suites són les mateixes que abans: `cargo llvm-cov` executa les proves del motor
amb binaris instrumentats i una prova que falla continua fent fallar el job (tasca de CI). Encara
no es fixa cap llindar; el primer informe de `main` és la referència que la porta
«per PR» del pla farà servir per exigir que la cobertura per paquet no baixi. El
job `go-windows` i el mòbil no mesuren cobertura en aquest lliurament.

Referència local del motor Rust en el codi d'aquest lliurament (Linux, 891 proves):
61,7 % de línies, 59,1 % de funcions, 58,5 % de regions. És una mesura de
sessió, no un llindar ni evidència de CI; el valor de referència oficial serà el
del primer artefacte a `main`.

Localment: `go test -coverprofile`, `bun test --coverage` i, amb
`cargo-llvm-cov` i el component `llvm-tools-preview` instal·lats,
`cargo llvm-cov --manifest-path meron-core/Cargo.toml`.

## Auditoria automàtica d'accessibilitat

`frontend/e2e/startup.e2e.ts` executa `@axe-core/playwright` amb les regles
WCAG 2.1 A/AA sobre tres pantalles de l'entrada de producció: la
incorporació sense compte i la bústia amb compte, llista i conversa, en els
temes clar i fosc a 1440 px. Una violació `critical` o `serious` fa fallar la
prova; el resultat complet, incloses les moderades i menors i les regles
`incomplete`, s'adjunta a l'informe i s'escriu a `startup-results/axe-*.json`,
que ja puja l'artefacte `baseline-<sha>`.

La primera execució va trobar una violació greu real: l'accent del tema
fosc (`#7ea6ff`) sobre el fons actiu (`#293f63`) donava 4,42:1 a la carpeta
i al compte seleccionats. El fons actiu fosc passa a `#253a5c` (4,78:1 amb
l'accent, 9,7:1 amb el text, continua distingible de la superfície) i
`themes.test.ts` exigeix des d'ara accent sobre fons actiu ≥ 4,5:1 en tots dos
temes per defecte.

El que aquesta auditoria no cobreix continua a #37: ordre de focus real, anuncis de
lector de pantalla, comprovació nativa a Windows, pantalles secundàries i els
estats amb el pont real. Una execució verda és absència de violacions
detectables per regla, no accessibilitat verificada.

## CardDAV contra un servidor real al job d'integració

`radicale_harness_test.go` engega Radicale 3.5 a Docker amb autenticació
htpasswd, emmagatzematge en disc i drets només del propietari, igual que
`maddy_harness_test.go` engega el servidor de correu. `integration_contacts_test.go`
prova la ruta CardDAV del motor contra aquest servidor: descobriment des d'una adreça
base, primera lectura, canvi al servidor recollit per una sincronització
posterior, contrasenya rebutjada notificada i conservada amb el seu error, i
servidor inaccessible sense perdre els contactes ja llegits.

El servidor queda disponible també per a CalDAV (#101) i per a les proves de
contactes parcials de #28 i #41. La imatge es baixa al job `integration`;
l'informe d'acceptació continua cobrint només `TestIntegrationMailFlow`, però una
fallada de `TestIntegrationContacts` fa fallar el job.

Perquè aquesta ruta fos comprovable, el mode `MERON_KEYRING=off` del motor
desa ara els secrets en memòria durant la vida del procés, com prometia el seu propi
comentari: una font de contactes que emmagatzema la contrasenya i la llegeix
en sincronitzar funciona igual que amb clauer; només es perd la persistència
entre reinicis. Els registres Graph continuen tancant-se en cas d'error (fail closed) en aquest mode.

## Simulador Graph i enregistraments EWS: abast decidit

- **Graph.** Les proves Rust de `graph/` ja aixequen un servidor HTTP local per
  prova (límit de peticions, àmbits, continuació, cancel·lació, reversió de
  memòria cau). Falta un simulador reutilitzable que travessi el sidecar sencer i que
  serveixi per a les escriptures de #141–#143. Decisió: extreure el servidor fals a un
  mòdul auxiliar compartit quan arribi la iteració 3, amb les respostes enregistrades
  que necessitin aquestes slices; ara no s'afegeix un segon simulador paral·lel.
- **EWS.** `ews-smoketest.py` prova contra un Exchange real a mà. Els
  enregistraments SOAP reproduïbles exigeixen un servidor de proves o enregistraments
  autoritzats (dependència 6 del pla). Fins aleshores, la cobertura EWS continua
  sent la unitària d'`exchange.rs` i l'execució manual de la prova bàsica (smoke test);
  no s'inventen enregistraments sintètics que simulin un servidor mai observat.

## Fluxos natius a Windows: disseny, pendent d'execució

`scripts/test-windows-startup.ps1` demostra arrencada, reinici, elecció Graph
i zoom. El següent script, `test-windows-mail-flows.ps1`, ha de, sobre
l'executable de SHA exacte i un perfil sintètic: iniciar maddy local, afegir un
compte IMAP per l'assistent, obrir un missatge sintètic, respondre, tancar
l'aplicació amb un esborrany obert i comprovar-ne la recuperació en tornar-la a obrir. Cada
pas fa servir l'accessibilitat de Windows com l'script actual, deixa captura de pantalla i
geometria, i no toca comptes reals. No s'inclou en aquest lliurament perquè no
hi ha executor (runner) Windows en aquesta sessió per validar-lo; un script sense executar no és
evidència i no ho ha de semblar. Entra amb #147 a la iteració 6.
