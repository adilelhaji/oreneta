# ADR-0038: Suprimir un perfil amb dades

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: #99, sobre l'ADR-0016.

## Problema

Les contrasenyes i les claus d'un perfil són al clauer del sistema, amb
noms que només coneix la seva pròpia base. Suprimir-ne les carpetes des d'un altre
perfil deixaria aquestes entrades al clauer per sempre. Per això, fins
ara, només es podia suprimir un perfil que no s'havia obert mai.

## Decisió

- **Bloqueig de perfil obert:** cada procés té un bloqueig del sistema
  sobre `.oreneta-running.lock` a la carpeta del seu perfil mentre
  s'executa (`flock` o `LockFileEx`). Suprimir un perfil pren primer aquest
  bloqueig, de manera que un perfil obert en una altra finestra no se suprimeix («tanca-la
  primer»).
- **Confirmació:** per a suprimir un perfil amb dades cal escriure'n el
  nom exacte. El text diu què se suprimeix d'aquest equip i que el correu
  i les dades dels servidors no es toquen.
- **Clauer:** el nucli s'executa una vegada dins d'aquest perfil
  (`--purge-profile`, amb el seu `MERON_PROFILE` i la seva base). Llegeix la base i
  suprimeix cada entrada que anomena:
  - els comptes;
  - les llibretes;
  - els calendaris CalDAV;
  - el xat i el núvol;
  - les claus OpenPGP i les identitats S/MIME;
  - la contrasenya de les còpies programades;
  - els registres de Graph.

  La clau de la base se suprimeix l'última. Mai no actua sobre el perfil
  principal. Una prova compta els llocs del nucli que desen un
  secret i falla si n'apareix un de nou sense afegir-lo a aquesta llista.
- **Ordre:**
  1. purgar;
  2. treure el perfil de la llista, perquè ja no es pugui obrir;
  3. alliberar el bloqueig (Windows no suprimeix un fitxer obert);
  4. suprimir les carpetes.
- **Si la purga falla** (la base no es pot llegir, el clauer no respon):
  no se suprimeix res i es pregunta. «Suprimir igualment» deixa aquestes entrades
  al clauer, i es diu.

## Alternatives descartades

- **Enumerar el clauer per prefix:** no totes les plataformes ho
  permeten.
- **Demanar que s'obri el perfil i se'n treguin els comptes a mà:** era el que
  es feia abans. És lent, i un perfil que no es pot obrir (base malmesa) no es
  podia suprimir mai.
