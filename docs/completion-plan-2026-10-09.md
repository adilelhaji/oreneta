# Plan para completar Oreneta frente a eM Client, con verificación por capas

Revisión: **2026-10-09**. Código auditado: `9ac12e603121dcc00bb91d5e5a7914b6245e75a7`
(main, CI verde en las siete suites: [run 37448687522](https://github.com/adilelhaji/oreneta/actions/runs/37448687522)).
Referencia estable: **eM Client 10.4.5674.0 para Windows**, sin cambios.

Este documento actualiza la secuencia del [plan competitivo](competitive-delivery-plan.md)
del 2026-10-05 con lo entregado desde entonces y la convierte en una lista ordenada
de iteraciones hasta tres candidatos con alcance declarado. Cada iteración lleva
sus entregas de prueba; la sección 5 define qué significa «bien testeado» y qué
infraestructura de verificación falta construir. No sustituye la
[matriz de paridad](emclient-parity-plan.md) ni la [auditoría de issues](competitive-backlog-audit.md),
y no aprueba ninguna arquitectura nueva. Los números y estados proceden de GitHub,
del ledger y de una inspección del código; **no son evidencia de aceptación**.

## 1. Estado actual en cifras

| Indicador | Valor (2026-10-09) |
|---|---|
| Issues abiertas | 81 (79 del programa de paridad + #181 zoom nativo + #188 paquete Store) |
| PRs abiertas | 0 |
| Ledger de aceptación (#22) | 39 filas: **0 verified**, 4 implemented-unverified, 8 partial, 27 unassessed |
| Manifiesto del backlog | 50 entregas: 40 unassessed, 5 implemented-unverified, 5 partial |
| Entregado desde la auditoría del 05-10 | 15 PRs fusionadas (#151–#187) |
| Tamaño del código | Frontend ≈48 k líneas TS/TSX, motor Rust ≈68 k, app Go ≈10 k |
| Binario validado | Ninguno para el SHA actual; el ejecutable local es anterior (#114/#147) |

### Cobertura de pruebas existente, por capa

| Capa | Qué hay | Cuánto | Dónde corre |
|---|---|---|---|
| Unitarias Rust (motor) | Protocolo IMAP/SMTP/EWS, parser MIME, store, Graph, crypto, calendario | ≈890 tests | job `rust` |
| Unitarias Go (app de escritorio) | Cuentas, rutas, notificaciones, actualizaciones, pegado, S/MIME, Graph OAuth | 164 funciones de test en 33 ficheros | jobs `go`, `go-windows` |
| Unitarias y de componente TS | Estados, lib, componentes, fixtures baseline | ≈915 casos en 93 ficheros | job `frontend` (bun test) |
| Entrada de producción | Arranque y navegación con bridge Wails simulado, 1440/1024/600 px, claro/oscuro, zoom | `frontend/e2e/startup.e2e.ts` + `frontend/baseline/` (Playwright) | job `frontend` |
| Integración aislada | Flujo IMAP/SMTP real contra maddy en Docker, 39 subtests, 12 resultados de usuario, IDLE ×3 | `integration_test.go` + informe JSON | job `integration` |
| Móvil | Tests Kotlin shared/ui | 61 ficheros | job `mobile` |
| Política de CI | Gate de release, ledger, aceptación, validación Windows | 64 tests Node | job `workflow-policy` |
| Nativo Windows | Arranque, reinicio, elección Graph, zoom con rueda y teclado | `scripts/test-windows-startup.ps1` | `windows-validation.yml`, **manual** |
| Rendimiento | Generador determinista 1k/10k/100k, orden y filtro | `scripts/perf/` | local, sin CI |
| Proveedor real | Procedimiento documentado, **no ejecutado** | [provider-acceptance.md](provider-acceptance.md) | ninguno |

### Huecos de verificación que el plan debe cerrar

- **Sin medida de cobertura** en ninguna capa; no se puede exigir que no baje.
- **Go sin tests dedicados** en ficheros con lógica: `mail.go` (981 líneas), `oauth.go`
  (499), `sidecar.go` (407), `calendar.go` (366), más `sweep.go`, `rules.go`, `junk.go`,
  `pgp.go`, `smime.go`, `feeds.go`. Parte está cubierta de forma indirecta por
  `app_*_test.go`.
- **Rust con módulos grandes sin tests inline**: `rss.rs` (1792 líneas, 0 tests),
  `backend.rs` (595, 0), `thread_list.rs` y `thread_read.rs` (≈600 cada uno, 4–5 tests),
  `unified.rs` (2). `backup.rs` depende solo de `backup/tests.rs`.
- **Integración solo IMAP/SMTP**: no hay servidor EWS, Graph, CalDAV ni CardDAV en
  CI. `ews-smoketest.py` existe pero solo contra un Exchange real y a mano.
- **Nativo Windows limitado al arranque**: ningún flujo de correo (añadir cuenta,
  leer, responder, recuperar borrador) se ejecuta en el binario real.
- **Accesibilidad sin comprobación automática**: los tests de producción miran foco
  y teclado, pero no ejecutan un auditor de contraste/roles.
- **Rendimiento sin dispositivo de referencia** y sin umbrales calibrados.
- **Ninguna fila `verified`** del ledger: toda evidencia es sintética.

### Lo que se entregó entre el 05-10 y el 09-10

- Diseño: controles compartidos (#152), selección de tabla (#154), lector (#156),
  foco de diálogos (#158), columnas configurables y ADR-0009 (#160), coherencia de
  pantallas secundarias (#177), jerarquía visual del buzón (#187).
- Operación: búsqueda de ajustes ES/EN (#163), salud de sincronización por cuenta
  (#165, #168), almacén durable de borradores (#169, PR #174), lector espera al
  iframe (#175).
- Evidencia: ADR-0010 recuperación completa local (#146), informe de aceptación
  IMAP/SMTP por operación (#184), validación de entrada Win32 y zoom nativo (#180,
  #182, #183).

Todo ello es **parcial** respecto a sus issues padre (#33–#39, #149, #150, #145,
#147): fixtures sintéticos y pruebas de componente, sin evidencia nativa ni de
proveedor real.

## 2. Comparación capacidad por capacidad

Resultado de inspeccionar el código actual, no de probarlo contra eM Client.
«Existe» significa que hay implementación y tests automáticos; «sin evidencia»
que falta la verificación nativa/proveedor que exige el ledger; «ausente» que no
hay código para la función.

### Existe, falta aceptación nativa/proveedor

| Capacidad | Dónde | Issue que cierra la aceptación |
|---|---|---|
| Correo IMAP/SMTP/EWS: carpetas, sync, envío, flags, mover | `meron-core/src/{imap,smtp,exchange}.rs` | #98/#145, #46/#48 |
| Graph **solo lectura** (carpetas, delta, cuerpos) | `meron-core/src/graph/` | #141 acciones, #142 adjuntos, #143 envío |
| Buzón: columnas, densidad, selección, paginación, vistas guardadas | `frontend/src/components/threads/` | #30, #34, #36 |
| Búsqueda con operadores y filtros rápidos | `SearchUnderstoodBar`, `QuickFilterBar`, `SavedSearchMenu`, `search/` | #31, #43 |
| Lector: HTML aislado, zoom, acciones por mensaje, impresión | `components/chat/`, `lib/print*.ts` | #35 |
| Redacción: firmas, plantillas, corrector, adjuntos, envío programado, undo, snooze | `components/composer/`, `states/{scheduledSends,sendQueue}` | #39/#170, #40, #88, #89, #45 |
| Reglas locales, spam idempotente, etiquetas, prioridad | `rules/`, `spam/`, `labels.go`, `priority/` | #50, #95 |
| Calendario: agenda/semana/mes, edición, recurrencia, Google, Exchange, suscripciones `.ics` | `components/calendar/`, `calendar/` | #100, #101 |
| Invitaciones y disponibilidad (parcial, Exchange) | `EventDetails.tsx`, `exchange.rs` | #102 |
| Personas (CardDAV), tareas enlazadas a mensaje, kanban, RSS | `carddav/`, `tasks.go`, `components/{people,tasks,kanban}` | #28, #41, #42 |
| PGP y S/MIME | `crypto/`, `pgp.go`, `smime.go` | #9, #12, #49 |
| Asistente con proveedor explícito y resultados revisables | `assistant.rs`, ADR-0006/0007 | #51, #52 |
| Privacidad: imágenes remotas, diagnóstico redactado, copia de configuración | `readerHtml.ts`, `applog.go`, `backup.go` | #54, #107 |
| Escritorio: notificaciones, bandeja, mailto, proxy, atajos, actualizaciones, OOF | raíz Go | #114/#147, #181 |
| Ajustes buscables ES/EN y salud de cuentas | #163, #165 | #149, #150 |

### Ausente en el código (requiere implementación, y en algunos casos decisión)

| Capacidad eM Client | Issue | Decisión previa |
|---|---|---|
| Categorías de bandeja con corrección del usuario | #91 | No |
| Notas independientes con sincronización | #104 | **Sí**: almacenamiento e identidad |
| Listas de tareas completas y sincronizadas | #103 | **Sí**: conflicto con tarea única por hilo |
| POP3 | #97 | **Sí**: retención e identidad |
| Importación/exportación (mbox, eml, pst) y archivos locales | #112 | Formatos a soportar |
| Correo personalizado masivo | #90 | No |
| Macros de acción rápida | #92 | No |
| QuickText | #88 | No |
| Espacio de todos los adjuntos | #93 | No |
| Favoritos y colores de carpeta, arrastre seguro | #87 | No |
| Barra lateral contextual (agenda, persona, historial de archivos) | #86 | No |
| CalDAV | #101 | No |
| Reglas en servidor y reenvío/vacaciones por proveedor | #94 | Por proveedor |
| Grupos de cuentas y perfiles aislados | #99 | **Sí**: modelo de perfil |
| Graph: escritura, adjuntos, envío, calendario, contactos, delegación | #141–#143, #47, #48 | ADR-0004 ya aprobada |
| Copia completa cifrada: captura, restauración aislada, programación | #171–#173 | ADR-0010 ya aprobada |
| Gramática y traducción sin conexión | #105, #106 | ADR-0001 ya aprobada |
| Adjuntos en nube y reuniones en línea | #108, #109 | **Sí**: proveedores y consentimiento |
| Chat (directo, grupo, canal) | #110 → #111 | **Sí**: límites del adaptador |
| Paquete Microsoft Store validado | #188 | Identidad de Partner Center |

Nota: la vista «chat» actual de Oreneta es un modo de conversación de correo
heredado de Meron, no el chat de eM Client; no cuenta para C26.

## 3. Qué significa «completar la app»

Definimos tres candidatos acumulativos. Cada uno tiene un alcance declarado y se
puede entregar a usuarios por separado; «completa» en sentido de paridad es el
tercero. Ninguno se considera alcanzado hasta que sus filas del ledger estén
`verified`.

| Candidato | Alcance | Puertas del plan anterior |
|---|---|---|
| **C-A: Correo Windows profesional** | Varias cuentas IMAP/M365/EWS, leer, buscar, responder con archivos, borradores recuperables, organización básica, instalación y actualización comprobadas | R0 + R1 |
| **C-B: Agenda e información personal** | C-A + invitaciones completas, contactos editables, tareas y notas completas, importación y copia completa | R2 |
| **C-C: Paridad estable Windows** | C-B + automatización, categorías, privacidad/idioma, integraciones, chat, POP3, perfiles; macOS/Linux con evidencia propia | R3 + R4 |

## 4. Secuencia de iteraciones con sus pruebas

Timeboxes de dos semanas con **una entrega principal** por iteración, sus pruebas
en la misma PR y una línea de evidencia (#22) por entrega. Las iteraciones se
ordenan por riesgo y por dependencia; no son promesas de fecha. La **iteración 0**
construye la infraestructura de prueba que las demás necesitan; sin ella, las
iteraciones 3–4 (Graph) y 8 (calendario) solo podrían probarse con mocks.
Accesibilidad (#37), privacidad (#54) y rendimiento (#53) se revisan en cada
iteración, no al final. Los niveles de prueba (N1–N6) se definen en la sección 5.

### Iteración 0: infraestructura de verificación

| Entrega | Resultado | Issue |
|---|---|---|
| Cobertura medida en CI | `cargo llvm-cov`, `go test -cover`, cobertura de bun; informe por paquete subido como artefacto; sin umbral todavía | #53 (nueva hija) |
| Servidor CalDAV/CardDAV en integración | Contenedor Radicale junto a maddy; fixture de calendario y contactos sintéticos | #101/#41 (nueva hija) |
| Simulador Graph en integración | Servidor HTTP local con respuestas grabadas (carpetas, delta, 429, 401, continuación); los fixtures Rust actuales pasan a correr contra él | #47 (nueva hija) |
| Harness EWS reproducible | Convertir `ews-smoketest.py` en un test Go con etiqueta `ews` que use grabaciones SOAP cuando no hay servidor; ejecución real solo manual | #46/#98 (nueva hija) |
| Flujos nativos Windows | Extender `test-windows-startup.ps1` con un segundo script de flujos: añadir cuenta IMAP contra maddy local, leer, responder, cerrar y recuperar borrador | #147 (nueva hija) |
| Auditor de accesibilidad | `@axe-core/playwright` en `startup.e2e.ts` y baseline; fallos críticos bloquean, el resto se reporta | #37 |

Criterio de salida: las ocho suites existentes siguen verdes, el informe de
cobertura aparece en cada PR y la validación Windows incluye al menos un flujo
de correo completo.

Estado (2026-10-09): cobertura en CI, auditoría axe (con una violación seria real
corregida en el tema oscuro) y Radicale con cinco casos CardDAV entregados; el
simulador Graph se difiere a la iteración 3 sobre los servidores falsos ya
existentes, las grabaciones EWS esperan la dependencia 6 y el script de flujos
nativos queda diseñado sin ejecutar. Detalle y límites en
[verification-infrastructure.md](verification-infrastructure.md). La iteración 1
empezó por #29 ([contrato](design/outgoing-mail-recovery.md)).

### C-A: correo Windows (R0/R1)

| It. | Entrega principal | Issues | Pruebas obligatorias en la PR | Salida comprobable |
|---|---|---|---|---|
| 1 | **Integridad P0** | #27 sweep acotado, #29 envío incierto durable, #28 contactos ante sync parcial, #9/#12 crypto | N1: reproducción de cada riesgo como test que falla antes y pasa después; N3: envío interrumpido contra maddy (corte tras DATA, reinicio del sidecar) y CardDAV parcial contra Radicale; N1 crypto con claves generadas por GnuPG/OpenSSL en el test | Cada riesgo con reproducción automatizada y corrección fusionada; decisiones #24/#25 solo donde bloqueen |
| 2 | **Borradores y redacción completos** | #170, #39, #40 | N1 store de borradores (concurrencia, disco lleno, registro corrupto); N2 editor con reinicio simulado, pestañas múltiples, adjuntos; N4 flujo nativo «escribir, cerrar app, reabrir» | Reinicio, fallo de disco y pestañas múltiples sin pérdida; vistas previas por tipo y error |
| 3 | **Graph escritura** | #141 acciones, #142 adjuntos | N1 Rust por operación (éxito, 429 con Retry-After, 401 revocado, respuesta parcial, cancelación); N3 contra el simulador Graph; N2 UI deshabilita lo no soportado también por teclado y en lote | Flags/mover/borrar con resultado recuperable; adjuntos acotados |
| 4 | **Graph envío y continuidad Exchange** | #143, #46, #48 | N3 envío con desconexión entre `createMessage` y `send`, verificando que no se duplica; harness EWS con grabaciones para delegación y OOF; N5 una ejecución autorizada contra M365 si hay cuenta | Envío con resultado incierto durable; exposición EWS Online documentada por cuenta/operación |
| 5 | **Shell de correo cerrado** | #33, #34, #35, #36, #87, #30 | N2 producción en 599/600/601, 768/769, 1024/1025, 1440 y zoom 200 %; capturas baseline claro/oscuro comparadas; N3 orden estable con llegadas concurrentes contra maddy; N6 axe sin errores críticos | Flujo completo de lectura/organización en app nativa; favoritos, colores y arrastre; orden estable entre páginas |
| 6 | **Candidato instalable** | #144, #147, #181, #148, #188 (solo validación), #145 | N4 instalar, actualizar desde la versión anterior, desinstalar y restaurar perfil sintético; N6 medidas 1k/10k/100k en el dispositivo de referencia; N5 filas live IMAP y M365 con el procedimiento de [provider-acceptance.md](provider-acceptance.md) | Ejecutable de SHA exacto con manifiesto; filas S01 y de proveedor a `verified` donde haya evidencia; piloto #55 decidido |

Criterio de salida C-A: los ocho flujos de #32 aplicables (todos menos
invitaciones) completados en el binario nativo con cuentas de prueba autorizadas,
ninguna fila obligatoria de correo en `partial`, cobertura de `mail.go`,
`oauth.go`, `sidecar.go`, `imap.rs`, `smtp.rs`, `exchange.rs` y `graph/` no
inferior a la de la iteración 0 y sin ficheros Go de lógica de correo sin test.

### C-B: agenda e información personal (R2)

| It. | Entrega principal | Issues | Pruebas obligatorias en la PR | Decisión previa |
|---|---|---|---|---|
| 7 | **Copia completa y restauración** | #171, #172, #173, #113 | N1 formato versionado (contraseña incorrecta, corrupción byte a byte, versión futura, interrupción a mitad); N3 captura con escrituras concurrentes del sidecar; N4 restauración nativa en perfil aislado y activación reversible | ADR-0010 ya aprobada |
| 8 | **Calendario e invitaciones** | #100, #101 (CalDAV), #102 | N3 contra Radicale (recurrencia, zonas horarias, conflicto de ETag) y harness EWS (invitar, aceptar, cancelar, free/busy); N1 iTIP con fixtures RFC 5546; N2 vistas con fechas límite (cambio de hora, años bisiestos) | Ninguna |
| 9 | **Contactos y tareas** | #41, #42, #103 | N3 CardDAV edición con conflicto y deduplicación; N1 modelo de tareas con migración desde tarea enlazada; N2 flujos de recuperación | Modelo de tareas completas (ADR nueva) |
| 10 | **Notas, importación y perfiles** | #104, #112, #99 | N1 importación mbox/eml con corpus malformado (cabeceras rotas, codificaciones mixtas, adjuntos truncados) y propiedad de ida y vuelta exportar→importar; N3 aislamiento entre perfiles (credenciales, caché, borradores); N4 cambio de perfil nativo | Almacenamiento de notas, formatos de importación, modelo de perfil (tres ADR) |

Criterio de salida C-B: flujo de invitación completo verificado en Exchange y
Google (N5); restauración ensayada en Windows (N4); importación de al menos
mbox/eml con corpus de regresión versionado en el repositorio.

### C-C: paridad estable y otras plataformas (R3/R4)

| It. | Entrega principal | Issues | Pruebas obligatorias en la PR | Decisión previa |
|---|---|---|---|---|
| 11 | **Organización avanzada** | #91 categorías, #92 macros, #93 adjuntos, #43 vistas vivas, #95 etiquetas | N1 clasificación determinista con corrección del usuario persistente; N3 macros solo sobre el conjunto revisado (regresión de #27); N2 vistas vivas que no amplían el lote | Ninguna |
| 12 | **Automatización y envío avanzado** | #94, #88, #89, #90, #45 | N3 reglas de servidor por proveedor (Sieve contra maddy, EWS inbox rules grabadas); N1 masivo con resultado parcial por destinatario; N3 undo/programado con reinicio a mitad | Capacidades por proveedor |
| 13 | **Privacidad e idioma** | #107, #105, #106, #49, #50 | N1 bloqueo de trackers con corpus de HTML real anonimizado; N1 gramática/traducción con modelos empaquetados y comprobación de ausencia de red (test que falla si hay socket); N5 interoperabilidad crypto con Thunderbird/Outlook en cuentas de prueba | ADR-0001 ya aprobada |
| 14 | **Integraciones y asistente** | #51, #52, #108, #109 | N1 contexto del asistente: test que falla si sale un campo no consentido; N3 proveedores de nube con simulador y revocación | Proveedores y consentimiento (ADR) |
| 15 | **Chat y POP3** | #110 → #111, #97 | N3 POP3 contra maddy (UIDL, reconexión, borrado diferido, sin duplicados tras reinicio); chat según el adaptador aprobado | Dos ADR |
| 16 | **Plataformas y evolución** | #115, #116, #117, #86, #22/#21 | N4 macOS con runner propio para arranque y un flujo de correo; Linux con `startup:verify` sobre WebKitGTK; ledger completo | Ninguna |

Criterio de salida C-C: todas las filas obligatorias Windows/proveedor del ledger
`verified`; cualquier exclusión mantiene la declaración de **paridad parcial**.

## 5. Estrategia de verificación

### Niveles y qué prueba cada uno

| Nivel | Qué es | Herramienta | Cuándo corre |
|---|---|---|---|
| **N1 Unitario** | Lógica pura por módulo: parsers, estados, store, contratos de error | `cargo test`, `go test`, `bun test` | Cada PR |
| **N2 Componente y entrada de producción** | UI con bridge simulado: foco, teclado, anchos, temas, zoom, idioma | bun test + Playwright (`startup.e2e.ts`, `baseline/`) | Cada PR |
| **N3 Integración aislada** | Sidecar real contra servidores locales (maddy, Radicale, simulador Graph, grabaciones EWS) | `go test -tags integration` + informe JSON | Cada PR |
| **N4 Nativo** | Binario real de Windows (y después macOS/Linux): instalación, flujos, recuperación | `windows-validation.yml` + scripts PowerShell | Por iteración y por candidato |
| **N5 Proveedor real** | Cuentas de prueba autorizadas: Gmail, Workspace, M365, EWS on-prem | Procedimiento de `provider-acceptance.md`, evidencia en el ledger | Por candidato |
| **N6 No funcional** | Rendimiento 1k/10k/100k, memoria, accesibilidad (axe), contraste | `scripts/perf/`, axe en Playwright, dispositivo de referencia | N6-a11y cada PR; N6-perf por iteración |

### Qué significa «bien testeado» para una slice

Una PR solo se fusiona si cumple todo lo siguiente; los padres solo cierran
cuando además hay N4/N5 aplicable.

1. **Cada caso de aceptación del issue tiene un test con su nombre** y el test
   falla sin el cambio (demostrado en la PR cuando es una corrección).
2. **Las seis familias de casos** están cubiertas: éxito, límite, error,
   interrupción/recuperación, aislamiento entre cuentas y regresión de defectos
   anteriores. Si una familia no aplica, la PR lo dice.
3. **Ninguna ruta de escritura hacia un proveedor sin test de resultado
   incierto**: desconexión entre petición y confirmación, reintento y
   deduplicación.
4. **Cobertura por paquete no baja** respecto a main; un descenso exige
   justificación explícita en la PR.
5. **Ningún test se omite, desactiva o marca como flaky** para obtener verde;
   un test inestable se corrige o se elimina con su issue.
6. **Entrada de producción** para todo cambio visual: 600/1024/1440, claro/oscuro,
   español e inglés, teclado y 200 % de zoom, con captura subida como artefacto.
7. **Evidencia nombrada por SHA** en el ledger: estado real alcanzado
   (`implemented-unverified`, `partial` o `verified`), nunca inferido de un mock.

### Infraestructura que falta y orden de construcción

| Pieza | Por qué | Iteración |
|---|---|---|
| Cobertura en CI con informe por paquete | Para poder exigir que no baje | 0 |
| Radicale en el job `integration` | CalDAV/CardDAV sin cuenta real; necesario para #28, #41, #101 | 0 |
| Simulador Graph local con grabaciones | Única forma de probar 429/401/continuación de forma repetible; necesario para #141–#143 | 0 |
| Harness EWS con grabaciones SOAP | Reproducir sin servidor lo que `ews-smoketest.py` hace a mano; necesario para #46, #48, #102 | 0 |
| Script de flujos nativos Windows | Pasar de «arranca» a «funciona»; necesario para #147 y todo N4 | 0, ampliado en 2, 6, 7, 10 |
| axe en Playwright | Accesibilidad automática mínima para #37 | 0 |
| Corpus de regresión de correo real anonimizado | HTML ancho, trackers, codificaciones, adjuntos raros; alimenta N1 del lector e importación | 5, 10, 13 |
| Dispositivo Windows de referencia con medidas repetidas | Calibrar umbrales de #53 y memoria de #148 | 6 |
| Runner macOS | N4 para #115 | 16 |
| Tests Go para `mail.go`, `oauth.go`, `sidecar.go`, `calendar.go` | Lógica de puente sin test dedicado hoy | 1–2 (correo), 4 (OAuth), 8 (calendario) |
| Tests Rust para `rss.rs`, `backend.rs`, `thread_list.rs`, `thread_read.rs`, `unified.rs` | Módulos grandes con 0–5 tests | 5 (listas), 11 (RSS y unificado) |

### Puertas de calidad

| Puerta | Condición |
|---|---|
| **Por PR** | Siete suites verdes en el SHA exacto, cobertura no inferior, N2 con capturas si hay cambio visual, revisión técnica y de producto |
| **Por iteración** | `windows-validation.yml` lanzado sobre el merge commit final; ledger actualizado; N6-perf registrado si la iteración toca listas, caché o arranque |
| **Por candidato** | Filas N5 ejecutadas con cuentas autorizadas; instalación, actualización y recuperación nativas; comparación de flujos de #32 aplicables; ninguna fila obligatoria del candidato por debajo de `verified` |
| **Para publicar** | Gate de `verify-release.yml` + firma + decisión humana separada; este plan no la concede |

## 6. Dependencias que solo el responsable puede resolver

Estas no se desbloquean escribiendo código; conviene abrirlas ya porque
condicionan la iteración 6 y posteriores.

1. **Credenciales OAuth propias** (Google y Microsoft) para #144; sin ellas no hay
   candidato distribuible con inicio de sesión ni filas N5 de Gmail/M365.
2. **Cuentas de prueba dedicadas** por proveedor (IMAP genérico, Gmail, Workspace,
   M365, EWS on-prem) y autorización escrita de operaciones y destinatarios, para
   #145/#98. Sin ellas el ledger no puede pasar de `implemented-unverified`.
3. **Equipo Windows de referencia** para evidencia nativa (#147, #148, #181) y
   política de firma/Application Control; identidad de Partner Center para #188.
4. **Cinco decisiones de arquitectura** en forma de ADR antes de su iteración:
   tareas completas (#103), notas (#104), perfiles (#99), POP3 (#97), chat (#110);
   más proveedores de nube/reuniones (#108/#109).
5. **Participantes del piloto** (#55): protocolo listo en C-A, inscripción aparte.
6. **Un servidor Exchange de pruebas** (o grabaciones autorizadas de uno) para el
   harness EWS de la iteración 0.

## 7. Reglas de ejecución que se mantienen

- Una slice por PR, con `Closes #N` solo si cubre todos los criterios; los padres
  quedan abiertos hasta cumplir todo.
- Tests de éxito, límite, error, interrupción, aislamiento y regresión; CI del SHA
  exacto antes del merge commit; comprobación de main después.
- Actualizar #22 y #21 al cerrar cada iteración, separando implementado, probado
  con fixtures, verificado nativo y verificado proveedor.
- Nada de este plan publica versiones, modifica cuentas o contrata servicios.

## 8. Primera acción recomendada

Empezar por la **iteración 0** en paralelo con **#29** (envío incierto durable).
La iteración 0 es pequeña por pieza y desbloquea las pruebas de Graph, calendario
y nativas; #29 es el riesgo de pérdida de datos con más impacto y #143 y #170
dependen de su contrato. Abrir a la vez las solicitudes externas del apartado 6
para que la iteración 6 no quede bloqueada por falta de credenciales, cuentas o
dispositivo.
