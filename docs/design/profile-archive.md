# Còpia completa del perfil (#171, #172; ADR-0010, ADR-0017)

## Ús

A **Configuració → Còpia de seguretat → Perfil complet** hi ha tres accions:
- **Copia…** demana una contrasenya d'almenys 8 caràcters, confirmada, i
  on es desa el fitxer `.oreneta-profile`.
- **Comprova…** obre un fitxer en una carpeta privada, comprova cada
  entrada i la base de dades, i diu què conté i què no. El perfil en ús no es
  toca.
- **Restaura…** fa el mateix i després demana confirmació:
  - El perfil en ús s'aparta; no s'esborra.
  - El restaurat entra amb tots els comptes en pausa; se sincronitza en
    reprendre cadascun, i les seves contrasenyes es tornen a demanar si el clauer
    no les té.
  - Els enviaments programats queden retinguts.
  - La finestra es recarrega.

Mentre el perfil anterior continua apartat, la mateixa secció ofereix **Torna**
(el reposa tal com era) o **Conserva** (l'esborra).

## Com s'activa

1. El nucli deixa preparada la restauració a `restore-staging/ready`:
   - la base de dades, tornada a xifrar amb la clau de l'equip;
   - els comptes en pausa, els enviaments retinguts i cap secret;
   - les imatges;
   - `READY.json`.
2. El pont atura el nucli i espera que el procés acabi i que se n'hagi llegit la
   sortida, perquè Windows alliberi els fitxers.
3. Abans de moure res, el pont escriu un diari amb cada moviment i si hi havia
   alguna cosa al seu lloc. Després aparta la base de dades, el seu WAL/SHM i les
   carpetes d'imatges, i hi col·loca les restaurades.
4. Arrenca el nucli i li demana la llista de comptes. Si no obre la base de
   dades, es desfà amb el diari i s'arrenca sobre el perfil anterior.
5. En arrencar l'aplicació, un diari a mitges es desfà abans que el nucli obri la
   base de dades.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 Rust (`profile_archive/tests.rs`) | Anada i tornada només amb la contrasenya; res de llegible al fitxer; la memòria cau, fora; contrasenya errònia o curta, o fitxer aliè; 40 bytes canviats i 4 talls detectats; camins maliciosos (`..`, absoluts, unitats, barres inverses, `//`, `.`) i noms repetits; versió o esquema futurs i manifest fals; una fallada conserva la còpia anterior; preparació tornada a xifrar, comptes en pausa, enviaments retinguts, sense secrets, sense restes després d'una fallada i sense clau en un equip sense clauer |
| N1 distribuïdor (`main.rs`) | Exportar i inspeccionar sense tocar el perfil en ús; la clau de la base de dades no surt del nucli |
| N1 Go (`restore_test.go`, `sidecar_restart_test.go`) | Intercanvi complet i perfil anterior apartat; conservar; tornar exactament; tall després de cada pas, i a mitges d'un pas, desfet en arrencar; fallada a mitges que reposa l'anterior; res sense un fitxer comprovat; el nucli s'atura i es reinicia com a procés nou; temps llargs per copiar i restaurar |
| N2 (`ProfileArchiveDialog.test.tsx`, `RestoreStatusRow.test.tsx`) | Contrasenya mínima i confirmada; comprovació amb contrasenya errònia i llista d'exclusions; restaurar només després de comprovar i confirmar; fallada que no recarrega; tornar i conservar |
| N4 pendent | A Windows: nucli i WebView2 oberts durant l'intercanvi, disc ple i interrupció reals |
