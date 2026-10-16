# Tasques enllaçades a missatges: validació (#42)

Validació, a `main`, de les tasques locals enllaçades a una conversa.
El disseny aprovat no canvia: tasques locals, una tasca oberta per
conversa i sense sincronització remota.

## Estat respecte als criteris de #42

| Criteri | Estat | Prova |
|---|---|---|
| La implementació és a `main` | Sí | `store::save_task` i les següents, `tasks.*` al nucli, `TasksView` i `TaskDialog` |
| Sobreviu al reinici; crear-la dues vegades no la duplica | Sí | La tasca és a SQLite amb un índex únic parcial; `saving_a_task_twice_on_the_same_thread_edits_it_rather_than_duplicating_it` |
| Una fallada en llegir la nota no la sobreescriu en blanc | **Corregit** | Prova `when the task cannot be read` a `TaskDialog.test.tsx` |
| L'enllaç obre la conversa correcta o diu que no la troba | **Corregit** | `a_task_follows_its_conversation_to_the_folder_it_moved_to` i la prova de `TasksView` |
| Aïllament entre comptes i conflictes en reobrir | Sí, ampliat | `open_tasks_for_threads_is_scoped_to_the_account_and_excludes_completed`, `reopening_a_task_says_why_it_cannot_and_a_missing_task_is_an_error`, `removing_an_account_removes_its_tasks_and_no_others` |

## Defectes trobats i corregits

Cadascun es va reproduir amb una prova que fallava abans de corregir-lo.

- **Tasca duplicada amb dates iguals.** La llista unia la tasca amb «el
  missatge de data més recent». Si dos missatges del fil compartien aquesta
  data, la tasca sortia dues vegades. Ara un sol missatge representa la
  conversa, i els empats es decideixen per uid.
- **Conversa moguda.** Una tasca desava la carpeta on es va crear. Si el
  fil s'arxivava o es movia, la tasca sortia sense assumpte i, en obrir-la,
  anava a la carpeta buida. Ara el fil es busca primer a la seva carpeta i
  després a qualsevol altra. En tornar-la a desar, es registra la carpeta nova.
- **Fil que no és a la còpia local.** La visualització ho diu i no hi navega. Les
  claus `uid:N` identifiquen un missatge d'una sola carpeta, de manera que no es
  busquen en cap altra: s'informa que no es troba en lloc d'endevinar.
- **Nota il·legible.** Des del menú contextual, l'editor s'obre amb la nota
  buida i demana la real. Si aquesta lectura fallava, el diàleg es desbloquejava i
  desar esborrava la nota. Ara els camps i el botó Desa continuen
  bloquejats (també amb Retorn), i un avís explica per què.
- **Reobrir amb una altra tasca oberta al mateix fil.** Abans es mostrava
  l'error en brut de SQLite. Ara s'explica què cal fer. Marcar una tasca que ja
  no existeix és un error, no un èxit silenciós.
- **Compte eliminat.** Les seves tasques continuaven a la llista apuntant a un
  compte que ja no existeix. Ara s'eliminen amb el compte.
- Una fila il·legible de la llista és un error del qual s'informa, no una tasca que
  desapareix sense avís.

## Dades que queden en eliminar un compte (decidit a l'ADR-0011)

La validació va trobar 17 taules amb dades del compte que no s'esborraven en
eliminar-lo. Es va decidir i aplicar el següent:
- **S'esborren** tot l'estat i les dades personals: etiquetes, posposats,
  prioritat, correu brossa, regles, contactes sincronitzats amb les seves adreces
  i telèfons, llibretes (també les seves contrasenyes al clauer) i registres.
- **Es conserven** els esborranys, els enviaments programats i els intents
  d'enviament.
- Un enviament programat conservat queda abandonat: com que l'id d'un compte
  és la seva adreça, tornar-lo a afegir l'hauria enviat automàticament.
- El diàleg de confirmació i l'avís posterior diuen què s'ha quedat a
  l'equip.
- Una prova falla si una taula nova amb una columna de compte no és a
  cap de les dues llistes (`REMOVED_WITH_ACCOUNT`,
  `KEPT_ON_ACCOUNT_REMOVAL`).

Pendent: una visualització per exportar o esborrar aquest contingut conservat.
Avui els enviaments programats continuen a la seva llista, però els esborranys
d'un compte eliminat no tenen on veure's.

## Fora de l'abast

Les tasques independents, la sincronització de tasques amb CalDAV/Exchange i el
seguiment d'«esperant resposta» (#103) necessiten el seu propi ADR.
