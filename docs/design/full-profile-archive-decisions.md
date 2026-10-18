# Còpia completa del perfil: decisions pendents (#171, #172, #173, #113)

Amb data 2026-10-11. L'[ADR-0010](../adr/0010-full-profile-local-recovery.md)
decideix el què. Aquest document recull el que l'ADR no fixa i que cal decidir
abans d'escriure la captura. Cada punt porta una proposta; cap no està
implementada.

## Estat de la branca

- **Còpia actual.** La còpia que existeix és la de configuració de l'ADR-0008
  (`meron-core/src/backup.rs`): comptes, configuració, canals (feeds) i
  metadades PGP/S/MIME. La seva importació es fusiona sobre la base de dades en
  ús; no hi ha restauració aïllada.
- **Reutilitzable amb proves** (`backup/tests.rs`):
  - PBKDF2 amb 600 000 iteracions i AES-256-GCM amb AAD fixa;
  - rebuig de contrasenya incorrecta, de text xifrat manipulat, de versió
    futura i de paràmetres de derivació absurds.
- **Corregit el 2026-10-11.** Escriure una còpia esborrava l'anterior abans
  d'escriure la nova. Ara s'escriu a part i es reanomena en acabar, i un error
  conserva l'anterior intacta (`TestWritePrivateFileKeepsThePreviousBackupWhenTheWriteFails`).

## Decisions

> **Resoltes el 2026-10-11 per delegació** a
> l'[ADR-0017](../adr/0017-profile-archive-format.md), que adopta age per al
> xifratge en lloc de la composició pròpia del punt 1. El que segueix és la
> proposta original, conservada com a registre.

1. **Xifratge de perfils grans.**
   - AES-GCM d'una sola passada obliga a tenir tot l'arxiu en memòria i a
     posar-hi un límit.
   - Un perfil amb anys de correu supera fàcilment 1 GiB, de manera que cal
     xifrar per blocs: cada bloc autenticat amb el seu índex i un indicador
     d'últim bloc, a l'estil de la construcció STREAM.
   - És una composició nova sobre primitives existents. L'ADR-0010 demana
     reutilitzar primitives, no inventar construccions. Necessita revisió
     criptogràfica.
   - **Proposta:** blocs d'1 MiB amb AES-256-GCM, nonce = prefix aleatori de
     7 bytes + comptador de 32 bits + byte d'últim bloc; clau derivada amb el
     PBKDF2 actual.
   - **Alternativa:** límit de 512 MiB i una sola passada a la primera versió.
2. **Inventari.**
   - Hi entra: la base de dades completa (correu a la memòria cau, esborranys
     locals, intents d'enviament, configuració) i els fitxers multimèdia en
     línia desats.
   - **Proposta:** la memòria cau d'adjunts (`appCacheDir()/attachments`) es
     declara reconstruïble i s'exclou al manifest.
   - Hi ha estat de la interfície al `localStorage` del WebView, com
     `lib/sessionPref.ts`. **Proposta:** s'exclou i es declara.
   - L'ADR prohibeix anomenar «completa» una còpia amb omissions sense
     resoldre. N'hi ha prou de declarar les exclusions al manifest?
3. **Secrets.**
   - Contrasenyes del clauer, claus privades PGP/S/MIME i concessions de Graph
     del magatzem del sistema.
   - **Proposta:** fora per defecte; dins només si la persona ho marca, en una
     secció a part de l'arxiu amb el mateix xifratge.
   - Les concessions de Graph no es copien mai: es torna a iniciar la sessió.
4. **Clau de la base de dades restaurada (Windows).**
   - La còpia porta la base de dades xifrada amb una clau pròpia de l'arxiu.
   - En activar-la hi ha dues opcions: tornar a xifrar la base de dades amb la
     clau de l'equip, o desar la clau de l'arxiu a l'Administrador de
     credencials.
   - **Proposta:** tornar a xifrar amb la clau de l'equip. Així un perfil
     restaurat no depèn de l'arxiu.
5. **Límits i noms.**
   - **Proposta:** extensió `.oreneta-profile`, mida màxima d'entrada declarada
     de 4 GiB, camins relatius sense `..` ni unitats i espai lliure mínim de 2×
     la mida.
6. **Còpies programades (#173).**
   - **Proposta:** desactivades per defecte, carpeta triada per la persona i es
     conserven les 5 últimes. L'última còpia verificada no s'esborra mai.

## Què es pot fer sense decidir

- Captura de la base de dades en una transacció immediata, amb
  `sqlcipher_export` cap a una clau nova.
- Verificació de l'arxiu: integritat de SQLite, `user_version` no futura i
  validació de cada esborrany.
- Restauració en un directori aïllat amb diari d'activació i recuperació
  després d'una interrupció.
- Proves de corrupció byte a byte, truncament, camins maliciosos i escriptures
  concurrents.

Tot això depèn del format del contenidor (punt 1). Començar sense decidir-ho
obligaria a refer el format.

## Necessita Windows natiu

- Reanomenar el perfil amb el procés auxiliar (sidecar) o el WebView2 oberts.
- Interrupció i disc ple reals.
- Assaig de restauració sobre un candidat exacte (`windows-validation.yml`).
