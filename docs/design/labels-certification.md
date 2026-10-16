# Etiquetes, categories i anotacions: certificació (#95)

Inventari de com es marquen les converses, amb la prova que cobreix cada flux.
«Local» vol dir que s'ha comprovat amb proves automàtiques (N1–N3). La
verificació a Windows (N4) i amb proveïdors reals (N5) es fa una vegada, sobre
la versió final. Res d'aquest document no afirma paritat amb la referència
estable sense aquesta verificació.

## Què marca una conversa

| Marca | Abast | On es troba | Viatja al servidor | Nom i color |
|---|---|---|---|---|
| Etiqueta | Conversa, diverses alhora | `thread_labels` per compte | Només si s'enllaça (ADR-0002): Gmail sí; enllaços d'Exchange i IMAP desats, encara sense sincronitzar | Nom i color locals; Gmail no exposa el color per IMAP |
| Categoria de safata | Conversa a la seva carpeta, només una | `messages.category` més correccions (ADR-0023) | Mai | Nom i color locals |
| Destacat | Missatge; s'agrega per conversa | `\Flagged` del servidor | Sí | — |
| Llegit / no llegit | Missatge | `\Seen` del servidor | Sí | — |
| Prioritat | Missatge, jutjat localment | `messages.priority`, `sender_priority` | Mai | — |
| Posposat | Conversa | `snoozed_threads` | Mai | — |
| Tasca enllaçada | Conversa | `tasks` (ADR-0013) | Mai | — |
| Correu brossa après | Remitent | `sender_spam` (ADR-0005) | El moviment a Correu brossa sí | — |

## Fluxos

| Flux | Etiquetes | Categories | Evidència |
|---|---|---|---|
| Llista i filtre | Faceta `label:<id>` | Faceta `category:<id>` i pestanyes | `a_page_can_be_narrowed_to_one_label`, `rules_place_conversations_in_order_and_the_rest_is_other` |
| Unió de missatges (ADR-0002) | Una etiqueta enllaçada és a la conversa si algun missatge la porta | Decideix el missatge més recent | `a_linked_label_survives_on_a_thread_while_any_one_message_still_carries_it`, `rules_place_…` |
| Moure de carpeta | L'etiqueta segueix la conversa | Es torna a jutjar a la carpeta de destinació; les correccions es mantenen | `a_label_follows_a_move_survives_a_restart_and_stays_in_its_account`, `corrections_survive_a_resync_and_reopening` |
| Sincronització | Gmail reconcilia en tots dos sentits; una etiqueta sense enllaç no es toca | No se sincronitza | `reconciliation_never_touches_a_label_with_no_link_on_this_account`, `a_thread_gains_…`, `a_thread_loses_…` |
| Reinici | Es conserva | Es conserva | `a_label_follows_…`, `corrections_survive_…` |
| Aïllament per compte | La mateixa clau en un altre compte, sense etiqueta | Correccions per compte | `a_label_follows_…`, `corrections_are_per_account` |
| Cerca | Operador `label:` (només en aquest equip) | Per la pestanya, no per operador | `a_label_makes_a_search_one_only_this_computer_can_answer`, `a_label_can_be_searched_for_by_the_name_that_was_typed` |
| Accions en lot | Afegir o treure una etiqueta a tota la selecció, sense tocar les altres; s'atura davant d'una conversa que no és a la llista | Correcció d'una en una des del menú | `labelsBulk.test.ts` |
| Regles | «Afegeix una etiqueta» suma, no substitueix | Condicions pròpies de cada categoria | `a_rule_adds_a_label_without_removing_the_ones_already_there` |
| Redacció | No s'etiqueta un missatge abans d'enviar-lo | No s'hi aplica | Buit obert: el missatge enviat no té conversa local fins que torna d'Enviats |
| Separació | Una etiqueta no és una categoria ni a l'inrevés | — | `labels_and_inbox_categories_never_stand_in_for_each_other` |
| Supressió del compte | Les etiquetes per conversa i els enllaços se suprimeixen | Les correccions se suprimeixen | `account_removal_takes_the_corrections`, protecció de l'ADR-0011 |

## Pendent

- Escriure i llegir categories d'Exchange (EWS i Graph) i paraules clau IMAP
  per a etiquetes enllaçades. Necessita enregistraments d'un proveïdor real,
  que no es fabriquen.
- Etiquetar en redactar, si la referència estable ho ofereix. Es confirma a N4.
- Contrastar a N4/N5 amb la referència estable: els noms i els colors de les
  categories d'Exchange, i les marques de seguiment amb data.
