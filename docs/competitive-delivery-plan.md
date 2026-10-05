# Oreneta: plan para competir con eM Client

Revisión: **2026-10-05**. Programa: [#21](https://github.com/adilelhaji/oreneta/issues/21).
Código auditado: `c3c562f53ed3331a1fb06dfba128c00f65931629`.
Este documento actualiza el orden de ejecución del [plan de paridad](emclient-parity-plan.md),
sin eliminar su matriz completa ni aprobar cambios de arquitectura. Las fases R0–R4
son puertas de entrega; los hitos S01–S13 siguen agrupando las áreas de trabajo.

## Objetivo y criterio comercial

Primero, lograr una alternativa Windows fiable para correo profesional con varias
cuentas; después completar información personal, integraciones y paridad por plataforma.
Una versión útil para un segmento puede competir sin cubrir todas las funciones,
pero debe declarar su alcance: **correo Windows validado** no significa **paridad
completa con eM Client**. El éxito comercial se comprobará con usuarios, no con
el número de issues cerradas ni un porcentaje de pantallas parecidas.

La referencia estable se mantiene en **eM Client 10.4.5674.0 para Windows**.
El historial oficial consultado el 5 de octubre muestra **11.0.865.0 como beta**;
sus cambios se registran en #117, sin ampliar silenciosamente la aceptación estable.
Fuentes: [historial](https://www.emclient.com/release-history?os=win),
[correo](https://www.emclient.com/features-email),
[calendario/tareas](https://www.emclient.com/features-calendar),
[funciones generales](https://www.emclient.com/features-overview).

La diferenciación propuesta es concreta: interfaz coherente y rápida, estado de
cuentas comprensible, recuperación visible, control del contexto del asistente y
funciones locales de privacidad/idioma dentro de los ADR ya aprobados. Son objetivos
a medir; no se afirma que Oreneta ya supere al competidor en esos puntos.

## Estado reconciliado

- Se revisaron las **65 issues abiertas** y los trabajos cerrados relacionados.
  Todas tienen cabida en el alcance; no se cierran por haber entregado una parte.
  La [auditoría individual](competitive-backlog-audit.md) asigna fase, prioridad y decisión.
- #21 estaba cerrado aunque la aceptación integral seguía pendiente: se reactiva
  como programa, conservando su historial y sin crear un epic duplicado.
- #83/#84/#85 ya entregaron temas cobalto, vista convencional y corrección del
  límite estrecho. No hay que reimplementarlos. #33–#38 conservan el acabado restante.
- #125/#127/#128 aportan Graph de lectura; envío, acciones y adjuntos siguen fuera
  del contrato actual. #47 se descompone en tres entregas verificables.
- #50–#54 tienen avances integrados de spam, asistente, datos de rendimiento y
  diagnósticos. Sus criterios completos y pruebas nativas/proveedor siguen abiertos.
- La última CI del código auditado tiene siete suites satisfactorias
  ([ejecución](https://github.com/adilelhaji/oreneta/actions/runs/34483379658)).
  El binario local es del SHA `e20fe87a072f49486609f689456727958d02b2db`:
  su manifiesto acredita arranque, pero no instalador ni proveedores reales.
- El registro actual contiene 4 filas `implemented-unverified`, 8 `partial` y
  27 `unassessed`. Es un inventario parcial de aceptación, no una medición de toda
  la aplicación ni una prueba de ausencia de las funciones no evaluadas.

## Secuencia de entregas

Avance de diseño posterior a la auditoría (2026-10-05): controles compartidos
#152/#153, selección de tabla #154/#155, tamaño y acciones del lector #156/#157,
y ciclo de foco de diálogos #158/#159 integrados. ADR 0009 aprobó vista general y
excepciones por carpeta; #160 implementa el contrato y su
[configurador de columnas](design/mailbox-columns.md). Estas entregas no cierran
los criterios completos de #33–#37 ni sustituyen aceptación nativa. Los binarios
locales no se han actualizado con estas mejoras.

#177 extiende el [acabado visual](design/screen-consistency.md) a las pantallas
existentes: estados semánticos, iconos, sombras y movimiento coherentes; Personas,
Tareas y Calendario adaptados a ventanas estrechas y menú de acceso común. Incluye
lectura completa de textos largos, apertura por teclado y fechas del calendario
según el idioma de la app. #33/#38 conservan la aceptación funcional y nativa
restante; esta entrega no añade sincronización de contactos/tareas ni funciones
pendientes de calendario.

Descubrimiento de ajustes: #163/#164 incorpora búsquedas EN/ES, destinos de cuenta,
teclado y conservación de editores; [contrato y límites](design/settings-discovery.md).
#165 añade [observaciones de sincronización por cuenta](design/account-sync-health.md)
sin borrar incidencias al ocultar avisos ni certificar recuperación por respuestas
parciales. #149/#150 conservan la aceptación completa y nativa pendiente.

| Puerta | Resultado para el usuario | Trabajo principal | Condición de salida |
|---|---|---|---|
| **R0 — Confianza y evidencia** | Conservar datos y entender fallos antes de ampliar uso | #9/#12, #27–#29, contratos acotados #24/#25; medir #53, preparar #98/#114 y resolver alcance de recuperación | Reproducciones de riesgos resueltas o capacidad deshabilitada para el alcance; envío incierto sin reintento ciego; inventario de datos y decisión de recuperación; pruebas automatizadas verdes y límites explícitos |
| **R1 — Correo Windows competitivo** | Configurar cuentas, leer, buscar, responder con archivos y organizar sin fricción | #30–#40, #43/#45, #46–#48, #86–#89, #92/#93/#95/#96; nuevas slices Graph, OAuth, salud y ajustes | Flujo completo en app nativa, proveedor por proveedor; borradores recuperables; UX comparada; instalación/actualización comprobadas; ninguna afirmación de soporte basada solo en mocks |
| **R2 — Agenda y organización personal** | Coordinar reuniones y mantener contactos, tareas y notas | #28/#38/#41/#42, #99–#104; importación/recuperación #112/#113 según ADR | Sincronización, conflictos, recurrencia, invitaciones, permisos y recuperación demostrados; arquitectura nueva aprobada antes de código |
| **R3 — Paridad estable Windows completa** | Cubrir automatización, privacidad, idioma e integraciones del inventario | #49–#52, #90/#91/#94/#97, #105–#111; completar #22/#98/#112–#114 | Todas las filas obligatorias Windows/proveedor verificadas, incluidos formatos y servicios menos comunes; cualquier exclusión mantiene la declaración de paridad parcial |
| **R4 — Otras plataformas y evolución** | Extender la aceptación sin degradar lo existente | #37/#55/#115, con #116/#117 en inventario separado | Evidencia nativa propia de macOS y regresiones Linux; móvil/beta tienen alcance y aceptación independientes |

Las fases no son una cascada rígida: accesibilidad #37, privacidad #54, rendimiento
#53 y pruebas por proveedor #98 se aplican desde R0. Un fallo reproducido de
integridad/seguridad precede a cualquier mejora visual. Descubrimiento de calendario,
notas, tareas y chat puede adelantarse; su implementación espera las decisiones necesarias.
Importación y recuperación necesarias para un participante deben estar verificadas
antes de su piloto, aunque la cobertura completa de formatos pertenezca a R2/R3.

## Primeras iteraciones ejecutables

1. **Fiabilidad:** reconciliar #27/#28/#29 y #9/#12 contra el código actual;
   convertir cada riesgo en una reproducción automatizada y resolverlo en su issue.
   Abrir solo las decisiones concretas de #24/#25 que impidan la solución.
2. **Evidencia y continuidad:** preparar [#145](https://github.com/adilelhaji/oreneta/issues/145) y [#148](https://github.com/adilelhaji/oreneta/issues/148);
   continuar #170–#173 conforme ADR-0010 tras resolver #146 e iniciar
   [#147](https://github.com/adilelhaji/oreneta/issues/147). Actualizar exposición #46
   por cuenta/operación; no posponer Graph hasta terminar el rediseño.
3. **Correo completo:** ejecutar [#142](https://github.com/adilelhaji/oreneta/issues/142) y [#141](https://github.com/adilelhaji/oreneta/issues/141) como slices
   independientes; [#143](https://github.com/adilelhaji/oreneta/issues/143) después del contrato durable de #29. Completar
   #39/#40 con recuperación y adjuntos, no solo con apariencia.
4. **Experiencia diaria:** #33/#34/#35/#36, [#150](https://github.com/adilelhaji/oreneta/issues/150), [#149](https://github.com/adilelhaji/oreneta/issues/149)
   y #43. Verificar un flujo entero por incremento, con #37 desde el inicio.
5. **Candidato acotado:** [#144](https://github.com/adilelhaji/oreneta/issues/144), filas reales de [#145](https://github.com/adilelhaji/oreneta/issues/145) y
   [#147](https://github.com/adilelhaji/oreneta/issues/147); comparar los flujos aplicables al alcance del candidato y decidir la entrada
   de participantes mediante #55. La publicación sigue siendo una acción separada.

Trabajar en iteraciones de hasta dos semanas cuando se conozca la capacidad,
con un resultado demostrable por slice. Limitar trabajo en curso a una entrega
principal y sus comprobaciones; no abrir diez implementaciones simultáneas.
No se fija fecha final: primero medir dos iteraciones y disponibilidad de cuentas,
dispositivos y decisiones; después estimar por área con riesgos y rango de esfuerzo.
Tamaños S/M/L son relativos, no equivalencias automáticas en días.

## Mejoras visuales y funcionales

La revisión presente inspeccionó código, documentos y tareas; **no es una nueva
evaluación visual de la app renderizada**. Estas propuestas deberán verificarse
en producción antes de considerarse entregadas.

| Mejora | Dueño | Evidencia exigida |
|---|---|---|
| Identidad cobalto/navy coherente, tipografía, iconos y estados semánticos | #33 | Catálogo y pantallas reales claro/oscuro; normal, foco, hover, deshabilitado, error; sin halos decorativos ni biblioteca paralela |
| Buzón legible con selección inequívoca | #34/#36 | Distinguir abierto/no leído/foco/selección juntos; columnas configurables y persistentes; nuevos correos no amplían el lote revisado |
| Lectura y redacción centradas en el contenido | #35/#39/#40 | Acciones por mensaje, HTML ancho contenido, adjuntos y remitente visibles, borrador conservado tras fallo/reinicio |
| Contexto útil sin saturar la pantalla | #86 | Agenda, persona e historial de archivos con origen/cobertura; plegado, redimensionado y retorno de foco; no mezclar cuentas |
| Búsqueda comprensible | #31/#43/#93 | Filtros equivalentes a operadores, vistas guardadas, origen del resultado y cobertura incompleta diferenciada de cero resultados |
| Ajustes y comandos fáciles de encontrar | [#149](https://github.com/adilelhaji/oreneta/issues/149) | Búsqueda ES/EN, tildes/Unicode, teclado y contexto de cuenta; conservar fallback de otros idiomas y #37 abierto |
| Estado de cuenta y recuperación visibles | [#150](https://github.com/adilelhaji/oreneta/issues/150) | Fallos simultáneos de cuentas/servicios, reautenticación y reintento seguros; cerrar un aviso no equivale a resolver el problema |
| Agenda, personas, tareas y notas coherentes | #38/#100–#104 | Un flujo real por superficie; no cerrar por aplicar un tema; diferenciar local, sincronizado y solo lectura |

Mantener los contratos de [dirección artística](design/art-direction.md) y
[límites de paneles](design/mail-boundaries.md). La producción usa un panel bajo
769 CSS px y navegación completa por encima de 1024; el fixture histórico de
#32 no redefine esos límites. Verificar 599/600/601, 768/769, 1024/1025 y 1440,
zoom al 200%, textos largos y movimiento reducido; conservar preferencias existentes.

## Cómo demostrar que mejora la experiencia

#32/#55 comparan ocho tareas con contenido sintético equivalente en Oreneta y la
referencia estable: (1) configurar cuenta y entender capacidades; (2) localizar
correo/adjunto; (3) leer/responder; (4) redactar con archivo y recuperar borrador;
(5) archivar un lote revisado; (6) recuperarse de desconexión/permisos;
(7) tramitar una invitación; (8) encontrar un ajuste y usarlo con teclado.

Registrar éxito, tiempo, errores, ayuda necesaria, dispositivo, versión y límites
de cada muestra. La comparación automatizada mide comportamiento repetible;
la evaluación humana requiere participantes autorizados y no se sustituye por
los tiempos de un agente. Definir previamente cohortes, repeticiones y umbrales
antes de proclamar una mejora; no inventar una ganancia porcentual. En R1 se
comparan los flujos disponibles en el alcance del candidato: invitaciones siguen
como brecha explícita R2 hasta #102. La comparación completa de los ocho flujos
es una aceptación posterior, no un bloqueo implícito del correo Windows R1.

Rendimiento: medir 1k/10k/100k mensajes y calibrar los objetivos ya propuestos en
#53 (p95: reacción local 100 ms, primera página cacheada 500 ms, apertura de mensaje
descargado 300 ms). No son resultados obtenidos ni compromisos sin dispositivo de
referencia. Accesibilidad: teclado, foco, anuncios y zoom en cada entrega; contraste
según el contrato vigente y evidencia nativa para las afirmaciones de soporte.

## Decisiones y dependencias que no pueden ocultarse

- **Recuperación:** opción B aprobada el 2026-10-05 y registrada en
  [ADR-0010](adr/0010-full-profile-local-recovery.md) mediante #146. Se conserva la
  exportación de configuración y se añade recuperación completa local cifrada.
  Almacén de borradores #169 entregado en PR #174; integración del editor #170,
  captura #171, restauración aislada #172 y programación/retención #173 siguen
  pendientes. #113 permanece abierta; aprobación y almacenamiento no acreditan
  todavía una copia completa ni recuperación nativa.
- **Graph:** dirección aprobada en ADR-0004; las acciones conservan consentimiento
  incremental e identidad aislada. La revocación puede invalidar lectura y escritura.
  #46 verifica exposición real a la retirada de EWS Online; on-premises es distinto.
  [Guía oficial de Microsoft](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online).
- **OAuth distribuible:** [#144](https://github.com/adilelhaji/oreneta/issues/144) separa configuración de desarrollo y
  distribución. Revisar requisitos y excepciones vigentes, no asumir un coste de
  evaluación universal. [Verificación oficial de Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- **Pruebas por proveedor:** #98 no debe esperar a que POP3, delegación y todos los
  adaptadores estén completos para probar operaciones ya disponibles. Cada fila
  requiere su operación y acceso autorizados; el cierre global exige todas las filas.
- **Windows:** #114 puede comprobar instalación y flujos existentes antes del cierre
  de #53/#54/#113. La aceptación final mantiene rendimiento, privacidad y recuperación.
- **Otros modelos:** perfiles, tareas completas, notas, chat y nuevos contratos de
  integración/archivo conservan sus gates. No se decide arquitectura en este plan.

## Definición de entrega y seguimiento

Cada slice: requisitos reconciliados → documentación/ADR aplicable → código y
tests → revisión ligera técnica y de producto → PR → CI requerida del SHA exacto
→ merge commit → comprobación de main → evidencia nativa/proveedor aplicable.
Los padres permanecen abiertos hasta satisfacer todos sus criterios. Una tarea
de preparación puede cerrarse al entregar el procedimiento; nunca certificar
por ello un proveedor o plataforma que no se haya probado.

#22 mantiene la matriz de aceptación, y #21 la secuencia y bloqueos. Actualizar
ambos al cerrar cada iteración; declarar por separado implementado, probado con
fixtures, verificado nativo y verificado proveedor. Las diez tareas nuevas son
subdivisiones del alcance existente, recogidas en el manifiesto; no sustituyen las
65 tareas originales ni reducen la matriz del producto.

Este encargo entrega planificación y tareas. No inicia por sí mismo su implementación,
no publica versiones, no modifica cuentas/tenants ni contrata servicios. Toda
limitación de acceso, decisión o plataforma sigue visible hasta resolverse.
