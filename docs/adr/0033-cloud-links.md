# ADR-0033: Compartir fitxers per enllaç des d'emmagatzematge al núvol

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Sense servei nou de pagament.
- Data: 2026-10-12.
- Abast: #108.

## Decisió

- **Proveïdors ara:**
  - Nextcloud i ownCloud, amb WebDAV per a pujar i l'API OCS per a
    l'enllaç;
  - una contrasenya d'aplicació, desada al clauer del sistema i
    mai a la base de dades;
  - només HTTPS, excepte loopback per a proves, i mai no se segueix una
    redirecció amb la contrasenya;
  - vBoxxCloud, com que és Nextcloud, es fa servir com a Nextcloud.
- **Proveïdors bloquejats:**
  - Dropbox, OneDrive i Google Drive necessiten registres OAuth propis
    d'Oreneta, que només pot crear el propietari;
  - es mostren com a «encara no disponibles», no a mig fer;
  - leitzcloud queda fora fins que hi hagi documentació de la seva API.
- **Flux:**
  - abans de pujar, es veu la destinació (servidor, carpeta i nom; un nom
    ocupat porta número i mai no se sobreescriu);
  - també es veu el que permetrà l'enllaç: només veure, contrasenya
    (activada per defecte i generada a l'atzar) i caducitat (per defecte 7
    dies, o el màxim del servidor);
  - el que el servidor exigeix (contrasenya o caducitat obligatòria, dies
    màxims) es llegeix de les seves capacitats i s'aplica abans de crear res;
  - la pujada mostra el progrés i es pot cancel·lar; cancel·lada o fallida,
    se suprimeix el que s'ha pujat;
  - en crear l'enllaç es llegeix el que el servidor ha concedit. Si permet
    editar, no caduca quan s'ha demanat, canvia la data o perd la
    contrasenya, es retira i es diu;
  - l'enllaç s'insereix al missatge només en prémer, amb la seva caducitat; la
    contrasenya no es posa al missatge;
  - un enllaç fet es pot retirar en lloc d'inserir-lo.
- **Errors:** contrasenya revocada (401/403), emmagatzematge ple (507),
  cancel·lació i discrepàncies de permisos tenen el seu propi missatge.

## Pendent

- Dropbox, OneDrive i Google Drive quan existeixin els registres OAuth.
- N5: provar contra un Nextcloud real en la verificació final.
