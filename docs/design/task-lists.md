# Llistes de tasques locals (#103, ADR-0013)

## Què fa

- **Tasques** mostra pestanyes per llista: «Totes», «Seguiment del correu» i
  les llistes creades. Es pot crear, reanomenar i suprimir una llista; en suprimir
  una llista se suprimeixen les seves tasques, després de confirmar-ho.
  «Seguiment del correu» no es pot suprimir.
- «Tasca nova» crea una tasca solta a la llista que s'està veient. Porta
  títol (obligatori), llista, data límit, recordatori (data i hora),
  prioritat (baixa, normal o alta) i nota.
- Una cerca filtra pel títol, l'assumpte, la nota i el remitent.
- Obrir una tasca solta l'edita; obrir-ne una d'enllaçada continua portant a la
  seva conversa.
- La prioritat alta es marca amb una bandera, i el recordatori pendent es
  veu a la fila.
- **Recordatoris.** Arriben com a notificació del sistema
  (`tasks.reminder`), una sola vegada. Només tornen a sonar si es canvia l'hora,
  i una tasca acabada no sona.
- **Conflictes.** Editar exigeix la revisió llegida. Si una altra finestra ha
  canviat la tasca, no es desa res i es mostren les dues còpies, amb la mateixa
  política que els contactes (ADR-0012).

## Model

- **Migració 39.**
  - Crea la taula `task_lists` amb la llista fixa `mail`.
  - Afegeix a `tasks` les columnes `list_id`, `title`, `priority`,
    `reminder_at`, `reminded_at` i `revision`.
  - Les tasques que ja existien passen a `mail` sense perdre camps (provat amb
    una actualització simulada).
- **Una tasca oberta per conversa.** Es manté: ara l'índex únic parcial
  només s'aplica a les tasques amb conversa (`thread_key <> ''`).
  Les soltes no tenen conversa i no compten per a aquesta regla.
- **Ordres del pont:**
  - noves: `tasks.lists`, `tasks.createList`, `tasks.renameList`,
    `tasks.deleteList`, `tasks.create` i `tasks.update`;
  - ampliades: `tasks.list` i `tasks.get` retornen els camps nous.
- **Llistes que arriben amb un compte (migració 66, ADR-0070).** La taula
  `account_task_lists` diu, per a cada compte, quines llistes té i en quin
  estat són: pendents de llegir, enllaçades, declinades o, per als servidors
  CalDAV, ja llistades. Un compte d'Exchange nou hi desa la seva entrada a la
  mateixa transacció que el compte. `tasks.lists` retorna aquestes entrades a
  `account_lists`, i `tasks.deleteList` declina la d'una llista del compte,
  de manera que no torna sola. El detall és a
  [caldav-tasks.md](caldav-tasks.md#llistes-que-arriben-amb-el-compte-281-adr-0070).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 magatzem (`store/task_lists/tests.rs`) | Les enllaçades van a `mail` i conserven la regla; les soltes no la tenen; llistes (crear, reanomenar, suprimir amb les seves tasques, `mail` protegida, una llista suprimida no admet tasques); conflicte de revisió; el recordatori sona una vegada i una altra només en moure'l, no si la tasca està acabada; l'actualització conserva les tasques |
| N1 distribuïdor (`main.rs`) | Recorregut complet a través del pont |
| N2 visualització (`TaskLists.test.tsx`) | Pestanyes i cerca; obrir una tasca solta l'edita; alta a la llista que es veu, amb títol obligatori; conflicte i «Conserva la meva» |
| N6 accessibilitat | Auditoria axe de Tasques i del seu editor, en tema clar i fosc |

## Fora d'aquest lliurament (ADR-0013)

Repetició, delegació, subtasques i aparició a l'agenda del calendari.
La sincronització amb CalDAV (VTODO) va arribar després, a l'ADR-0039
([registre](caldav-tasks.md)), i la carpeta Tasques d'un compte d'Exchange
(EWS) a l'ADR-0058. Des de l'ADR-0070, les dues arriben amb el compte, com
els calendaris. Google Tasks i Graph To Do continuen pendents.
