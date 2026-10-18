# ADR-0039: Llistes de tasques en un servidor CalDAV

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. L'ADR-0070 (acceptada pel propietari el 2026-10-18) esmena
  «Enllaç» (enllaç automàtic de les col·leccions de tasques d'un
  servidor afegit a un compte), «Suprimir una llista enllaçada», la nota de
  l'«Esquema 56» sobre la supressió per compte i l'aplicació de «Seguretat
  (#28)».
- Data: 2026-10-12.
- Abast: #103, pas «CalDAV VTODO primer», sobre l'ADR-0013, l'ADR-0012 i
  l'ADR-0018.

## Problema

Les llistes de l'ADR-0013 només viuen en aquest equip. El pas següent
acordat és sincronitzar-les amb CalDAV (VTODO), que es pot provar contra
Radicale. Faltava decidir:

- com s'enllaça una llista;
- què passa amb els canvis fets sense connexió;
- com es resol un conflicte;
- què es conserva del que han escrit altres programes.

## Decisió

- **Enllaç:** una llista s'enllaça amb una sola col·lecció del servidor. S'hi
  afegeix amb «Llista de tasques CalDAV…»: servidor i usuari, després la
  col·lecció i després el nom aquí.
  - La contrasenya va al clauer, amb el nom `caldav-tasks:{lista}`, i
    s'afegeix al que purga l'ADR-0038.
  - La llista es llegeix sencera abans d'afegir-la. Si aquesta lectura falla, no s'hi
    afegeix res i el quadre de diàleg diu per què.
  - S'ofereixen totes les col·leccions de calendari. No es pregunta quines
    accepten tasques: si una no les accepta, ho diu la primera lectura.
- **Canvis locals primer:** crear, editar, completar i suprimir es
  desen aquí i es marquen com a pendents (`put` o `delete`).
  - Una tasca suprimida que ja és al servidor queda oculta com a làpida (tombstone)
    fins que se suprimeix allà, perquè en cal la versió per a suprimir-la.
  - No s'envia res en segon pla. Se sincronitza en obrir Tasques i amb
    el botó «Sincronitzar».
- **Sincronitzar una llista:**
  1. **Enviar:** els canvis pendents surten d'un en un, cadascun amb
     la seva versió.
     - Una tasca nova va amb `If-None-Match: *`. La seva adreça es decideix i
       es desa abans d'enviar-la, perquè un reintent no en creï una altra
       còpia.
     - Una edició va amb `If-Match` i una supressió amb `DELETE` i `If-Match`.
     - Un 412 marca aquesta tasca en conflicte i atura la cua d'aquesta llista;
       les altres llistes continuen. Mentre la llista tingui un conflicte, no
       envia res més.
     - Un error de xarxa o del servidor atura la sincronització i es desa
       com a «últim error». No es perd res local.
  2. **Llegir:** es demanen totes les tasques de la col·lecció (`REPORT` amb
     `VTODO`, sense finestra de temps). És tot o res: si un objecte no
     torna, és en un altre servidor o no es pot llegir, la lectura falla i
     el que és local no canvia.
  3. **Conciliar** per adreça de l'objecte:

     | Servidor | Aquí | Resultat |
     |---|---|---|
     | Ha canviat | Sense canvis | Es pren la còpia del servidor |
     | Ha canviat | Amb canvis | Conflicte; no se'n sobreescriu cap |
     | Ha desaparegut | Sense canvis | Se suprimeix aquí |
     | Ha desaparegut | Amb canvis | Conflicte («suprimida al servidor») |
     | Nova | — | S'afegeix aquí |
- **Conflictes (ADR-0012), sense fusió silenciosa.** La tasca mostra
  «Conflicte» amb dues accions:
  - «Conservar la meva»: llegeix la versió actual del servidor i torna a
    posar la tasca a la cua sobre aquesta versió, o la torna a crear a la
    mateixa adreça si s'ha suprimit allà. Després sincronitza.
  - «Fer servir la del servidor»: pren la còpia del servidor, o suprimeix la tasca
    aquí si allà ja no existeix.
- **El que es conserva:** en escriure sobre un objecte existent només es
  canvien les propietats el valor de les quals ha canviat aquí. Tota la resta es queda
  igual: X-, `CATEGORIES`, `RELATED-TO`, `VTIMEZONE`, altres alarmes.
  `DTSTAMP` i `LAST-MODIFIED` s'actualitzen i `SEQUENCE` puja. Les tasques
  noves porten UID `<uuid>@oreneta`.
- **Correspondència de camps:**
  - `SUMMARY` ↔ títol i `DESCRIPTION` ↔ nota, amb escapaments.
  - `DUE` ↔ data límit:
    - una data sola és la mitjanit local;
    - una hora amb `TZID` es llegeix en la seva zona, i una sense zona, com a hora
      local;
    - en escriure, una mitjanit local va com a `VALUE=DATE` i qualsevol
      altra hora, en UTC.
  - `PRIORITY` ↔ prioritat: 1–4 és alta, 6–9 baixa i 5, 0 o cap,
    normal. En escriure, alta és 1, baixa és 9 i normal treu la propietat.
  - `STATUS:COMPLETED` i `COMPLETED` ↔ completada. Reobrir escriu
    `NEEDS-ACTION` i treu `COMPLETED` i `PERCENT-COMPLETE`.
  - La primera alarma amb hora calculable ↔ recordatori. Si el
    recordatori canvia aquí, les alarmes se substitueixen per una sola
    `DISPLAY` amb hora absoluta. Si no canvia, no es toquen.
- **Tasques que es repeteixen** (`RRULE`, `RDATE` o ocurrències canviades): es
  mostren, però no s'editen ni es completen aquí; el missatge ho diu.
  Sí que es poden suprimir.
- **Moure una tasca** entre una llista del servidor i una altra llista es rebutja
  de moment, amb un missatge.
- **Suprimir una llista enllaçada** suprimeix aquí la llista, les seves tasques i la seva
  contrasenya. No toca res del servidor, i el text de confirmació ho diu.
- **Seguretat (#28):** la contrasenya només va a l'origen de la col·lecció.
  Es comprova en enllaçar (amb les regles de `credentials_may_follow`
  a partir del que s'ha escrit) i a cada petició. Un objecte que el servidor
  situa en un altre origen fa fallar la lectura.
- **Esquema 56:**
  - `task_lists`: `remote_url`, `remote_user`, `synced_at` i `last_error`;
  - `tasks`: `remote_href`, `remote_etag`, `remote_ics`, `pending`,
    `conflict`, `recurring` i `sync_seq`.

  Cap columna no es diu `account`, de manera que no entren a la supressió per
  compte.

## Alternatives descartades

- **Sincronitzar en segon pla amb un temporitzador:** seria la primera
  tasca periòdica de xarxa de les tasques. Pot venir després. Obrir la visualització
  i el botó són suficients per a aquest lliurament.
- **Que guanyi l'últim que escriu:** contradiu l'ADR-0012.
- **Moure entre llistes** com a suprimir en una i crear en una altra: pot perdre
  dades si falla a mig camí. Es deixa per a quan calgui.
- **Llegir `supported-calendar-component-set`** per a filtrar col·leccions:
  demana una altra consulta per col·lecció i l'analitzador actual no llegeix atributs.
  La primera lectura ja informa d'una col·lecció que no serveix.

## Conseqüències

- Proves N1 amb un servidor fals i N3 contra Radicale; el detall és
  al [registre](../design/caldav-tasks.md).
- Google Tasks, Graph To Do i EWS continuen pendents, en aquest ordre
  (ADR-0013). EWS va arribar abans, amb l'ADR-0058.
