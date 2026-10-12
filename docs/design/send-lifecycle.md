# Envío inmediato, retenido y programado; pospuestos (#89, ADR-0024)

## Defectos encontrados y corregidos

| Defecto | Prueba |
|---|---|
| Una respuesta en su periodo para deshacer se perdía al cerrar o fallar la app | `held replies are kept by the core` (4 casos) en `compose.test.ts` |
| «Ya intentado» se tomaba por enviado: el segundo de dos envíos simultáneos borraba la fila aunque el primero pudiera fallar | `an_already_attempted_answer_is_not_taken_for_a_sent_message`, `a_scheduled_row_whose_attempt_already_went_is_not_sent_twice` |
| La contraseña de la clave podía guardarse con un mensaje programado | `a_scheduled_message_is_stored_without_a_passphrase_and_late_is_said` |
| No se avisaba de que la app debe estar abierta, ni de un envío tardío | Texto en el menú «Enviar más tarde» y aviso `late` del vigilante |
| Un hilo pospuesto y movido desaparecía de todas las vistas | `a_snoozed_conversation_moved_meanwhile_is_still_listed_where_it_is` |
| El aviso al despertar decía «de vuelta en tu bandeja» sin haberse movido | Texto corregido |

## Comportamiento

Ver ADR-0024 para las transiciones. Lo que no cambia:
- un envío incierto nunca se repite solo;
- reenviarlo es una decisión de la persona, con aviso.
