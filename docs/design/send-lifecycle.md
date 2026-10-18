# Enviament immediat, retingut i programat; posposats (#89, ADR-0024)

## Defectes trobats i corregits

| Defecte | Prova |
|---|---|
| Una resposta dins del període per desfer-la es perdia en tancar l'aplicació o si aquesta fallava | `held replies are kept by the core` (4 casos) a `compose.test.ts` |
| «Ja intentat» es prenia per enviat: el segon de dos enviaments simultanis esborrava la fila encara que el primer pogués fallar | `an_already_attempted_answer_is_not_taken_for_a_sent_message`, `a_scheduled_row_whose_attempt_already_went_is_not_sent_twice` |
| La contrasenya de la clau es podia desar amb un missatge programat | `a_scheduled_message_is_stored_without_a_passphrase_and_late_is_said` |
| No s'avisava que l'aplicació ha d'estar oberta, ni d'un enviament tardà | Text al menú «Envia més tard» i avís `late` del vigilant |
| Un fil posposat i mogut desapareixia de totes les visualitzacions | `a_snoozed_conversation_moved_meanwhile_is_still_listed_where_it_is` |
| L'avís en despertar deia «de tornada a la safata d'entrada» sense que s'hagués mogut | Text corregit |

## Comportament

Vegeu l'ADR-0024 per a les transicions. El que no canvia:
- un enviament incert no es repeteix mai sol;
- reenviar-lo és una decisió de la persona, amb avís.
