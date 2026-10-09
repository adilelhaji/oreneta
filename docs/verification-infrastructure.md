# Infraestructura de verificación (iteración 0)

Entregas de la iteración 0 del [plan de finalización](completion-plan-2026-10-09.md),
que preparan las pruebas que las iteraciones siguientes necesitan. Ninguna de
ellas certifica un proveedor real ni la aplicación nativa; declaran lo que miden
y dónde termina su evidencia.

## Cobertura medida en cada ejecución de CI

| Capa | Comando en `test.yml` | Artefacto |
|---|---|---|
| Go | `go test -tags webkit2_41 -coverprofile=coverage/go.out ./...` y `go tool cover -func` | `coverage-go-<sha>` (perfil y resumen) |
| Rust | `cargo llvm-cov --lcov` sobre `meron-core` y `cargo llvm-cov report --summary-only` | `coverage-rust-<sha>` (lcov y resumen) |
| Frontend | `bun test --coverage --coverage-reporter=lcov --coverage-reporter=text` | `coverage-frontend-<sha>` (lcov) |

Las suites son las mismas que antes: `cargo llvm-cov` ejecuta los tests del motor
con binarios instrumentados y un test que falla sigue fallando el job. No se fija
umbral todavía; el primer informe de `main` es la referencia que la puerta
«por PR» del plan usará para exigir que la cobertura por paquete no baje. El
job `go-windows` y el móvil no miden cobertura en esta entrega.

Referencia local del motor Rust en el código de esta entrega (Linux, 891 tests):
61,7 % de líneas, 59,1 % de funciones, 58,5 % de regiones. Es una medida de
sesión, no un umbral ni evidencia de CI; el valor de referencia oficial será el
del primer artefacto en `main`.

Localmente: `go test -coverprofile`, `bun test --coverage` y, con
`cargo-llvm-cov` y el componente `llvm-tools-preview` instalados,
`cargo llvm-cov --manifest-path meron-core/Cargo.toml`.

## Auditoría automática de accesibilidad

`frontend/e2e/startup.e2e.ts` ejecuta `@axe-core/playwright` con las reglas
WCAG 2.1 A/AA sobre tres pantallas de la entrada de producción: la
incorporación sin cuenta y el buzón con cuenta, lista y conversación, en los
temas claro y oscuro a 1440 px. Una violación `critical` o `serious` falla el
test; el resultado completo, incluidas las moderadas y menores y las reglas
`incomplete`, se adjunta al informe y se escribe en `startup-results/axe-*.json`,
que ya sube el artefacto `baseline-<sha>`.

La primera ejecución encontró una violación seria real: el acento del tema
oscuro (`#7ea6ff`) sobre el fondo activo (`#293f63`) daba 4,42:1 en la carpeta
y la cuenta seleccionadas. El fondo activo oscuro pasa a `#253a5c` (4,78:1 con
el acento, 9,7:1 con el texto, sigue distinguible de la superficie) y
`themes.test.ts` exige desde ahora acento sobre fondo activo ≥ 4,5:1 en ambos
temas por defecto.

Lo que esta auditoría no cubre sigue en #37: orden de foco real, anuncios de
lector de pantalla, comprobación nativa en Windows, pantallas secundarias y los
estados con el bridge real. Una ejecución verde es ausencia de violaciones
detectables por regla, no accesibilidad verificada.

## CardDAV contra un servidor real en el job de integración

`radicale_harness_test.go` levanta Radicale 3.5 en Docker con autenticación
htpasswd, almacenamiento en disco y derechos solo del propietario, igual que
`maddy_harness_test.go` levanta el servidor de correo. `integration_contacts_test.go`
prueba la ruta CardDAV del motor contra él: descubrimiento desde una dirección
base, primera lectura, cambio en el servidor recogido por una sincronización
posterior, contraseña rechazada notificada y conservada con su error, y
servidor inaccesible sin perder los contactos ya leídos.

El servidor queda disponible también para CalDAV (#101) y para las pruebas de
contactos parciales de #28 y #41. La imagen se descarga en el job `integration`;
el informe de aceptación sigue cubriendo solo `TestIntegrationMailFlow`, pero un
fallo de `TestIntegrationContacts` falla el job.

Para que esta ruta fuera comprobable, el modo `MERON_KEYRING=off` del motor
guarda ahora los secretos en memoria durante la vida del proceso, como su propio
comentario prometía: una fuente de contactos que almacena su contraseña y la lee
al sincronizar funciona igual que con llavero; solo se pierde la persistencia
entre reinicios. Los registros Graph siguen fallando cerrados en ese modo.

## Simulador Graph y grabaciones EWS: alcance decidido

- **Graph.** Los tests Rust de `graph/` ya levantan un servidor HTTP local por
  prueba (límite de peticiones, ámbitos, continuación, cancelación, reversión de
  caché). Falta un simulador reutilizable que atraviese el sidecar entero y que
  sirva a las escrituras de #141–#143. Decisión: extraer el servidor falso a un
  helper compartido cuando llegue la iteración 3, con las respuestas grabadas
  que esas slices necesiten; no se añade ahora un segundo simulador paralelo.
- **EWS.** `ews-smoketest.py` prueba contra un Exchange real a mano. Las
  grabaciones SOAP reproducibles exigen un servidor de pruebas o grabaciones
  autorizadas (dependencia 6 del plan). Hasta entonces, la cobertura EWS sigue
  siendo la unitaria de `exchange.rs` y la ejecución manual del smoke test;
  no se inventan grabaciones sintéticas que simulen un servidor nunca observado.

## Flujos nativos en Windows: diseño, pendiente de ejecución

`scripts/test-windows-startup.ps1` demuestra arranque, reinicio, elección Graph
y zoom. El siguiente script, `test-windows-mail-flows.ps1`, debe, sobre el
ejecutable de SHA exacto y un perfil sintético: iniciar maddy local, añadir una
cuenta IMAP por el asistente, abrir un mensaje sintético, responder, cerrar la
aplicación con un borrador abierto y comprobar su recuperación al reabrir. Cada
paso usa la accesibilidad de Windows como el script actual, deja captura y
geometría, y no toca cuentas reales. No se incluye en esta entrega porque no
hay runner Windows en esta sesión para validarlo; un script sin ejecutar no es
evidencia y no debe parecerlo. Entra con #147 en la iteración 6.
