# Plan para completar Oreneta frente a eM Client

Revisión: **2026-10-09**. Código auditado: `9ac12e603121dcc00bb91d5e5a7914b6245e75a7`
(main, CI verde en las siete suites: [run 37448687522](https://github.com/adilelhaji/oreneta/actions/runs/37448687522)).
Referencia estable: **eM Client 10.4.5674.0 para Windows**, sin cambios.

Este documento actualiza la secuencia del [plan competitivo](competitive-delivery-plan.md)
del 2026-10-05 con lo entregado desde entonces y la convierte en una lista ordenada
de iteraciones hasta tres candidatos con alcance declarado. No sustituye la
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
| Cobertura automatizada | 93 ficheros de test frontend, 33 Go, 53 módulos Rust con tests; 7 suites CI |
| Binario validado | Ninguno para el SHA actual; el ejecutable local es anterior (#114/#147) |

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

## 4. Secuencia de iteraciones

Timeboxes de dos semanas con **una entrega principal** por iteración y una línea
de evidencia (#22) por entrega. Las iteraciones se ordenan por riesgo y por
dependencia; no son promesas de fecha. Las iteraciones 1–6 cierran C-A, 7–10 C-B,
11 en adelante C-C. Accesibilidad (#37), privacidad (#54) y rendimiento (#53) se
revisan en cada iteración, no al final.

### C-A: correo Windows (R0/R1)

| It. | Entrega principal | Issues | Salida comprobable |
|---|---|---|---|
| 1 | **Integridad P0** | #27 sweep acotado, #29 envío incierto durable, #28 contactos ante sync parcial, #9/#12 crypto | Cada riesgo con reproducción automatizada y corrección fusionada; decisiones #24/#25 solo donde bloqueen |
| 2 | **Borradores y redacción completos** | #170 (editor + respuesta rápida + adjuntos), #39, #40 | Reinicio, fallo de disco y pestañas múltiples sin pérdida; vistas previas por tipo y error |
| 3 | **Graph escritura** | #141 acciones, #142 adjuntos | Flags/mover/borrar con resultado recuperable; adjuntos acotados; UI sigue deshabilitando lo no soportado |
| 4 | **Graph envío y continuidad Exchange** | #143, #46, #48 | Envío con resultado incierto durable; exposición EWS Online documentada por cuenta/operación |
| 5 | **Shell de correo cerrado** | #33, #34, #35, #36, #87, #30 | Flujo completo de lectura/organización en app nativa; favoritos, colores y arrastre; orden estable entre páginas |
| 6 | **Candidato instalable** | #144 OAuth propio, #147 instalar/actualizar/recuperar, #181 zoom teclado, #148 rendimiento nativo, #188 paquete Store (solo validación), #145 filas live IMAP/M365 | Ejecutable de SHA exacto con manifiesto; filas S01 y de proveedor pasan a `verified` donde haya evidencia; piloto #55 decidido |

Criterio de salida C-A: los ocho flujos de #32 aplicables (todos menos
invitaciones) completados en el binario nativo con cuentas de prueba autorizadas,
y ninguna fila obligatoria de correo en `partial`.

### C-B: agenda e información personal (R2)

| It. | Entrega principal | Issues | Decisión previa |
|---|---|---|---|
| 7 | **Copia completa y restauración** | #171 captura cifrada, #172 restauración aislada, #173 programación, #113 | ADR-0010 ya aprobada |
| 8 | **Calendario e invitaciones** | #100, #101 (CalDAV), #102 | Ninguna |
| 9 | **Contactos y tareas** | #41, #42, #103 | Modelo de tareas completas (ADR nueva) |
| 10 | **Notas, importación y perfiles** | #104, #112, #99 | Almacenamiento de notas, formatos de importación, modelo de perfil (tres ADR) |

Criterio de salida C-B: flujo de invitación completo verificado en Exchange y
Google; restauración ensayada en Windows; importación de al menos mbox/eml con
evidencia.

### C-C: paridad estable y otras plataformas (R3/R4)

| It. | Entrega principal | Issues | Decisión previa |
|---|---|---|---|
| 11 | **Organización avanzada** | #91 categorías, #92 macros, #93 adjuntos, #43 vistas vivas, #95 etiquetas | Ninguna |
| 12 | **Automatización y envío avanzado** | #94 reglas servidor, #88 QuickText, #89 ciclo completo, #90 masivo, #45 | Capacidades por proveedor |
| 13 | **Privacidad e idioma** | #107 trackers, #105 gramática, #106 traducción, #49 interoperabilidad crypto, #50 | ADR-0001 ya aprobada; modelos empaquetados |
| 14 | **Integraciones y asistente** | #51, #52, #108, #109 | Proveedores y consentimiento (ADR) |
| 15 | **Chat y POP3** | #110 → #111, #97 | Dos ADR |
| 16 | **Plataformas y evolución** | #115 macOS/Linux, #116 móvil, #117 beta 11, #86 barra contextual, #22/#21 cierre | Ninguna |

Criterio de salida C-C: todas las filas obligatorias Windows/proveedor del ledger
`verified`; cualquier exclusión mantiene la declaración de **paridad parcial**.

## 5. Dependencias que solo el responsable puede resolver

Estas no se desbloquean escribiendo código; conviene abrirlas ya porque
condicionan la iteración 6 y posteriores.

1. **Credenciales OAuth propias** (Google y Microsoft) para #144; sin ellas no hay
   candidato distribuible con inicio de sesión.
2. **Cuentas de prueba dedicadas** por proveedor (IMAP genérico, Gmail, Workspace,
   M365, EWS on-prem) y autorización escrita de operaciones y destinatarios, para
   #145/#98. Sin ellas el ledger no puede pasar de `implemented-unverified`.
3. **Equipo Windows de referencia** para evidencia nativa (#147, #148, #181) y
   política de firma/Application Control; identidad de Partner Center para #188.
4. **Cinco decisiones de arquitectura** en forma de ADR antes de su iteración:
   tareas completas (#103), notas (#104), perfiles (#99), POP3 (#97), chat (#110);
   más proveedores de nube/reuniones (#108/#109).
5. **Participantes del piloto** (#55): protocolo listo en C-A, inscripción aparte.

## 6. Reglas de ejecución que se mantienen

- Una slice por PR, con `Closes #N` solo si cubre todos los criterios; los padres
  quedan abiertos hasta cumplir todo.
- Tests de éxito, límite, error, interrupción, aislamiento y regresión; CI del SHA
  exacto antes del merge commit; comprobación de main después.
- Actualizar #22 y #21 al cerrar cada iteración, separando implementado, probado
  con fixtures, verificado nativo y verificado proveedor.
- Nada de este plan publica versiones, modifica cuentas o contrata servicios.

## 7. Primera acción recomendada

Empezar la iteración 1 por **#29** (envío incierto durable), porque #143 Graph
envío y #170 borradores dependen de su contrato, y es el riesgo de pérdida de
datos con más impacto para un usuario de correo profesional. En paralelo, abrir
las solicitudes externas del apartado 5 para que la iteración 6 no quede
bloqueada por falta de credenciales, cuentas o dispositivo.
