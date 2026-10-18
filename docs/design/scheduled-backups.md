# Còpies programades (#173; ADR-0037)

## Ús

A **Configuració → Còpia de seguretat → Còpies programades**:
- activar-les, triar la carpeta, cada dia o cada setmana, quantes se'n conserven
  i un límit d'espai opcional;
- la contrasenya, confirmada, es desa al clauer del sistema;
- **Copia ara** fa una còpia en aquell moment;
- es mostren l'última còpia bona, l'última fallada (amb «les còpies
  anteriors es conserven»), la següent i la llista de les que es conserven,
  i es marquen les que ja no són a la carpeta.

Es fa saber la fallada d'una còpia programada encara que Configuració estigui
tancada.

## Nucli

`meron-core/src/backup_schedule/`, RPC `backupSchedule.status`,
`backupSchedule.save`, `backupSchedule.runNow`, esdeveniment `backup.scheduled`.
Comprova cada 5 minuts, començant 2 minuts després d'obrir l'aplicació. Esquema 55.
El pont proporciona `backupSchedule.pickFolder` i passa `MERON_APP_VERSION`.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 Rust (`backup_schedule/tests.rs`) | Desactivada per defecte; una còpia perduda es fa una vegada i una fallada es torna a provar al cap d'una hora; configuració i carpeta (dins del perfil, que el conté, inexistent, relativa); retenció per nombre i per espai sense esborrar mai la comprovada més recent; còpia real escrita, comprovada i llegible; disc ple que ho conserva tot; còpia nova malmesa que s'esborra i deixa la bona amb «conserva'n 1»; només s'esborren fitxers propis sense canvis (ni notes, ni còpies manuals, ni un fitxer substituït); manual i programada mai alhora; aturada a mitges (sense comprovar o `.part`) que es neteja en arrencar sense tocar els `.part` d'altri; dues còpies en el mateix segon; perfil restaurat amb les còpies desactivades |
| N1 distribuïdor (`main.rs`) | Sense contrasenya no s'activa; la contrasenya no es retorna; copiar ara deixa una còpia comprovada; manual i programada s'exclouen |
| N2 (`BackupScheduleGroup.test.tsx`) | Desactivada per defecte; no es desa sense carpeta ni contrasenya confirmada; un canvi posterior no torna a enviar la contrasenya; fallada visible amb «es conserven»; còpia absent marcada; esdeveniment rebut amb Configuració oberta |
| N4 pendent | A Windows: còpia amb l'aplicació en ús, disc ple real, carpeta en una unitat extraïble desconnectada |
