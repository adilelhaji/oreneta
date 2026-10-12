# Etiquetas, categorías y anotaciones: certificación (#95)

Inventario de cómo se marcan las conversaciones, con la prueba que cubre
cada flujo. «Local» significa que se comprobó con pruebas automáticas
(N1–N3). La verificación en Windows (N4) y con proveedores reales (N5) se
hace una vez, sobre la versión final. Nada de este documento afirma paridad
con la referencia estable sin esa verificación.

## Qué marca una conversación

| Marca | Alcance | Dónde vive | Viaja al servidor | Nombre y color |
|---|---|---|---|---|
| Etiqueta | Conversación, varias a la vez | `thread_labels` por cuenta | Solo si se enlaza (ADR-0002): Gmail sí; enlaces Exchange e IMAP guardados, aún sin sincronizar | Nombre y color locales; Gmail no expone color por IMAP |
| Categoría de bandeja | Conversación en su carpeta, una sola | `messages.category` más correcciones (ADR-0023) | Nunca | Nombre y color locales |
| Destacado | Mensaje; se agrega por conversación | `\Flagged` del servidor | Sí | — |
| Leído / no leído | Mensaje | `\Seen` del servidor | Sí | — |
| Prioridad | Mensaje, juzgado localmente | `messages.priority`, `sender_priority` | Nunca | — |
| Pospuesto | Conversación | `snoozed_threads` | Nunca | — |
| Tarea enlazada | Conversación | `tasks` (ADR-0013) | Nunca | — |
| Spam aprendido | Remitente | `sender_spam` (ADR-0005) | El movimiento a Spam sí | — |

## Flujos

| Flujo | Etiquetas | Categorías | Evidencia |
|---|---|---|---|
| Lista y filtro | Faceta `label:<id>` | Faceta `category:<id>` y pestañas | `a_page_can_be_narrowed_to_one_label`, `rules_place_conversations_in_order_and_the_rest_is_other` |
| Unión de mensajes (ADR-0002) | Una etiqueta enlazada está en la conversación si algún mensaje la lleva | El mensaje más reciente decide | `a_linked_label_survives_on_a_thread_while_any_one_message_still_carries_it`, `rules_place_…` |
| Mover de carpeta | La etiqueta sigue a la conversación | Se juzga de nuevo en la carpeta de destino; las correcciones siguen | `a_label_follows_a_move_survives_a_restart_and_stays_in_its_account`, `corrections_survive_a_resync_and_reopening` |
| Sincronización | Gmail reconcilia en ambos sentidos; una etiqueta sin enlace no se toca | No se sincroniza | `reconciliation_never_touches_a_label_with_no_link_on_this_account`, `a_thread_gains_…`, `a_thread_loses_…` |
| Reinicio | Se conserva | Se conserva | `a_label_follows_…`, `corrections_survive_…` |
| Aislamiento por cuenta | Misma clave en otra cuenta, sin etiqueta | Correcciones por cuenta | `a_label_follows_…`, `corrections_are_per_account` |
| Búsqueda | Operador `label:` (solo en este equipo) | Por la pestaña, no por operador | `a_label_makes_a_search_one_only_this_computer_can_answer`, `a_label_can_be_searched_for_by_the_name_that_was_typed` |
| Acciones en lote | Añadir o quitar una etiqueta en toda la selección, sin tocar las demás; se detiene ante una conversación que no está en la lista | Corrección de una en una desde el menú | `labelsBulk.test.ts` |
| Reglas | «Añadir etiqueta» suma, no reemplaza | Condiciones propias de cada categoría | `a_rule_adds_a_label_without_removing_the_ones_already_there` |
| Redacción | No se etiqueta un mensaje antes de enviarlo | No aplica | Hueco abierto: el mensaje enviado no tiene conversación local hasta que vuelve de Enviados |
| Separación | Una etiqueta no es una categoría ni al revés | — | `labels_and_inbox_categories_never_stand_in_for_each_other` |
| Borrado de cuenta | Etiquetas por conversación y enlaces se borran | Correcciones se borran | `account_removal_takes_the_corrections`, guarda de ADR-0011 |

## Pendiente

- Escribir y leer categorías de Exchange (EWS y Graph) y palabras clave
  IMAP para etiquetas enlazadas. Necesita grabaciones de un proveedor real,
  que no se fabrican.
- Etiquetar al redactar, si la referencia estable lo ofrece. Se confirma en
  N4.
- Contrastar en N4/N5 con la referencia estable: los nombres y colores de las
  categorías de Exchange, y las marcas de seguimiento con fecha.
