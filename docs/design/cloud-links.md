# Enllaços a fitxers al núvol (#108)

Registre de la implementació de l'ADR-0033.

## Peces

- **Nucli:**
  - `meron-core/src/cloud/` conté els comptes (`cloud_accounts`, esquema 51,
    sense contrasenya), les capacitats, la pujada amb progrés i cancel·lació,
    l'enllaç comprovat i la seva retirada;
  - RPC `cloud.providers/list/save/check/remove/upload/cancel/share/revoke`;
  - esdeveniments `cloud.progress` i `cloud.uploaded`.
- **Pont Go:** `cloud.pickFile` tria el fitxer amb el diàleg natiu i en passa
  el camí, i el nucli el llegeix del disc.
- **Aplicació:** grup de Configuració «Emmagatzematge al núvol» i diàleg
  «Comparteix un fitxer per enllaç» al redactor.

## Proves

Contra un servidor local que respon com Nextcloud:
- la contrasenya no va a la taula, només hi ha proveïdors utilitzables i no
  s'admeten HTTP ni camins amb `..`;
- les capacitats es llegeixen bé;
- la pujada va a la seva carpeta amb un nom lliure i el camí es codifica;
- una contrasenya revocada i un emmagatzematge ple s'indiquen i es netegen;
- cancel·lar esborra el que s'ha pujat;
- l'enllaç és de només lectura, amb contrasenya i caducitat llegides de
  tornada;
- un enllaç editable, sense caducitat o sense contrasenya es retira;
- les exigències del servidor s'apliquen abans de crear res.

A l'aplicació: destinació i regles del servidor, progrés, enllaç final i el que
permet, la contrasenya fora del missatge, emmagatzematge ple i enllaç retirat.
A Go: descripció del fitxer triat.
