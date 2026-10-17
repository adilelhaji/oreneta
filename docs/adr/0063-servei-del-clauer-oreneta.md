# ADR-0063: Els secrets passen del servei de clauer `meron` a `oreneta`

- Estat: proposada; els objectius i els criteris d'acceptació de #248 són
  del propietari (2026-10-17). Aquest disseny es revisa a la PR.
- Data: 2026-10-17.
- Abast: #248, només el nom del servei del clauer i la migració de les
  entrades que ja hi ha.

## Context

El nucli desa els secrets de cada perfil (contrasenyes, testimonis d'OAuth,
la clau de la base SQLCipher, els registres de Graph) al clauer del sistema
sota el servei `meron`, el nom heretat. Cada entrada té un nom
(l'identificador del compte, `__meron_db_key__`, `profile:<id>/<nom>`,
`__oreneta_graph_v1_<resum (hash)>`…) i un valor, el blob JSON o la clau.
On viu cada entrada:

| Plataforma | Magatzem (`meron-core/src/secrets.rs`, `secrets_portal.rs`) | On es veu el servei |
|---|---|---|
| Windows | Administrador de credencials, credencials genèriques. Un blob de més de 1.200 unitats UTF-16 es reparteix en trossos (`<nom>--meron-g<n>c<i>`) i l'entrada principal en guarda la marca `meron-chunked:` | Nom de destinació `<nom>.meron` |
| macOS | Clauer d'inici de sessió, contrasenya genèrica | Servei `meron`, compte `<nom>` |
| Linux natiu | Secret Service per D-Bus (gnome-keyring, KWallet) | Atribut `service=meron` |
| Linux amb Flatpak, o sense Secret Service | oo7: el portal Secret o el fitxer local `<app>/keyring/meron.keyring` | Atribut `service=meron` i etiqueta `<nom>@meron` |
| Mòbil | Els secrets dels comptes van dins la base SQLCipher (`protocol/helpers.rs`), no al clauer. La clau de la base la guarda l'amfitrió: a iOS, servei `jp.nonbili.meron` i compte `meron_db_key` (`IosDbKey.swift`); a Android, l'àlies `meron_db_key` del Keystore i les preferències `meron_secure` (`MeronDbKey.kt`) | Cap no és el servei `meron`; no es veuen |

Reanomenar el servei sense més deixaria orfes totes les entrades: cap compte
no trobaria la contrasenya, i la base no s'obriria perquè se'n generaria una
clau nova.

## Decisió

- **Servei nou.** Tot el que s'escriu va al servei `oreneta`
  (`secrets_migration::SERVICE`). `meron` (`LEGACY_SERVICE`) només es llegeix
  i s'esborra. Els noms de les entrades i el format dels valors no canvien.
- **Ordre de consulta.** Primer `oreneta`; si no hi és, `meron`. El valor que
  es retorna és sempre el desat, intacte.
- **Moure una entrada.** Llegir `meron`, escriure el valor a `oreneta`,
  tornar a llegir `oreneta` i comparar-lo byte a byte, i només llavors esborrar
  `meron`. Si la còpia no coincideix o no es pot llegir, s'esborra la còpia
  d'`oreneta` (si no, una còpia dolenta taparia l'original, perquè `oreneta`
  es llegeix primer) i `meron` es queda com estava.
- **Quan es mou.**
  - En llegir una entrada per primera vegada a l'execució. Inclou la clau de
    la base, que es llegeix abans d'obrir el magatzem.
  - En engegar, en segon pla, cada nom que el magatzem coneix: la mateixa
    llista que fa servir la purga d'un perfil (`profile_purge::secret_names`,
    vigilada pel recompte de `secrets::store(`), més el registre de Graph de
    cada compte (`profile_purge::keychain_names`). Així també es mouen les
    entrades que la sessió no arriba a llegir.
- **Idempotència.** Cada execució torna a mirar les entrades que no ha
  resolt. Segons el que troba:
  - Només a `oreneta`: no fa res més.
  - Només a `meron`: la mou.
  - A tots dos llocs i iguals (una execució anterior en va fer la còpia però
    no va poder esborrar l'original): esborra `meron`.
  - A tots dos llocs i diferents: no esborra res, fa servir `oreneta` i
    n'avisa al registre.
  - Enlloc: no hi ha secret, i no s'escriu res.
- **Estat de l'execució, només en memòria.** Per a cada entrada: no mirada,
  resolta (`meron` ja no hi és) o ajornada (un pas ha fallat). Una entrada
  ajornada no es torna a provar fins a la propera engegada: així el registre
  no s'omple ni el clauer torna a demanar permís a cada lectura. Mentrestant
  es continua servint el valor de `meron`. No es desa cap marca de migració:
  el model de dades no canvia.
- **Desar un secret** (`store`) escriu a `oreneta`. Si encara hi pot haver
  l'entrada `meron` (estat no mirat), es torna a llegir la nova i, si
  coincideix, s'esborra la vella: el seu valor acaba de ser substituït. Si
  l'escriptura falla, es retorna l'error, com abans, i `meron` no es toca.
- **Esborrar un secret** (`delete`, la supressió d'un compte, la purga d'un
  perfil) esborra primer `meron` i després `oreneta`. Si falla el primer, no
  es toca el segon: mai no queda només una còpia a `meron` que una lectura
  posterior recuperaria.
- **Registre.** Etiqueta `keyring`. Cada pas fallat és un avís amb el nom de
  l'entrada, el pas i l'error del magatzem; una línia en engegar en dona els
  recomptes (mogudes, ajornades, il·legibles). Els noms ja surten als errors
  del clauer d'abans. Els valors no surten mai: ni al registre, ni als
  errors, ni a la sortida de les proves.

### Concurrència

- **Un procés per perfil.** El bloqueig d'instància única i el bloqueig del
  perfil (ADR-0016, ADR-0038) fan que només un procés obri cada perfil. Els
  noms del clauer porten el perfil, i dos perfils no comparteixen cap entrada.
- **Dins del procés**, cada entrada té el seu bloqueig, que serialitza llegir,
  moure, desar i esborrar. Així, la còpia del valor vell no pot trepitjar un
  testimoni d'OAuth acabat de renovar en un altre fil. Entrades diferents no
  s'esperen entre elles.
- **Una versió anterior** que obri el mateix perfil no fa servir aquests
  bloquejos ni veu `oreneta`. Si s'hi torna i s'hi torna a escriure una
  contrasenya, la versió nova trobarà dues entrades diferents: es queda amb
  `oreneta`, conserva `meron` i n'avisa. El proper `store` correcte ho resol.

### Estats de fallada

| Pas que falla | Què queda | El compte | Reintent |
|---|---|---|---|
| Llegir `meron` | Res escrit ni esborrat; error a qui llegeix, com abans quan el clauer fallava | Igual que abans d'aquest canvi | La lectura, a la propera lectura; el moviment, a la propera engegada |
| Escriure `oreneta` | `meron` intacta | Funciona amb `meron` | Propera engegada |
| Verificar la còpia | La còpia s'esborra; `meron` intacta | Funciona amb `meron` | Propera engegada |
| Esborrar la còpia no verificada | Error al registre; `meron` intacta | Llegeix `oreneta` primer | La propera engegada troba dues entrades diferents i no esborra res |
| Esborrar `meron` | Dues entrades iguals | Funciona amb `oreneta` | La propera engegada esborra `meron` |

### El que no es fa mai

- Esborrar `meron` abans que la còpia d'`oreneta` s'hagi rellegit idèntica.
- Esborrar `meron` quan és diferent d'`oreneta`.
- Generar una clau de base nova si cap dels dos serveis no s'ha pogut llegir:
  un error de lectura es retorna, no es pren per «no n'hi ha».
- Posar un valor secret en un missatge de registre o d'error.

## Fora d'abast

Es queden com són, perquè canviar-los canviaria el format del que hi ha desat
i cadascun demanaria la seva pròpia migració:

- els noms dins del servei: `__meron_db_key__`, els trossos `--meron-g…` i la
  marca `meron-chunked:` de Windows (l'Administrador de credencials encara
  mostrarà `<nom>--meron-g0c0.oreneta` per als blobs grans);
- el fitxer local `meron.keyring` i les variables `MERON_KEYRING` i
  `MERON_PROFILE`;
- les claus del mòbil (`jp.nonbili.meron`, `meron_db_key`, `meron_secure`),
  que no fan servir el servei `meron` ni es mostren;
- l'identificador de l'aplicació a Flatpak i el nom del binari del nucli
  (#247): el portal Secret és privat de cada aplicació, i si l'identificador
  canviés, el clauer seria un altre.

## Alternatives

1. **Moure en llegir i en engegar, amb verificació (escollida).**
2. **Només reanomenar.** Deixa orfes tots els secrets. Rebutjada.
3. **Llegir tots dos serveis per sempre sense moure res.** El nom heretat
   continuaria a la vista. Rebutjada.
4. **Desar una marca de «migració feta» a SQLite.** Estalviaria una lectura
   de `meron` per entrada en cada engegada, però afegeix estat al model de
   dades i una marca que pot no dir la veritat (un clauer restaurat).
   Rebutjada.
5. **Copiar i esborrar sense rellegir.** Una còpia truncada o fallida
   esborraria l'únic valor bo. Rebutjada pel requisit de #248.

## Conseqüències

- L'Administrador de credencials, el clauer de macOS i Seahorse mostren
  `oreneta`. Les entrades `meron` desapareixen a mesura que es mouen.
- Cada engegada fa una lectura de `meron` per entrada fins que la troba
  buida. És una cerca local, sense xarxa.
- Cal verificar-ho de manera nativa (N4), perquè la CI de la PR només executa
  les proves de Rust a Linux i no compila el codi propi de Windows:
  - Windows: un perfil amb comptes, inclòs un d'Outlook (blob a trossos),
    passa a `.oreneta` sense tornar a connectar.
  - macOS: si l'identitat del binari ha canviat (#247), el sistema pot
    demanar permís per llegir o esborrar les entrades `meron`. Si es denega,
    l'entrada es queda a `meron` i es torna a provar en la propera engegada.
  - Linux: Seahorse mostra les entrades sota `oreneta`.

## Verificació

Proves amb un magatzem de credencials fals a
`meron-core/src/secrets_migration.rs`:
- instal·lació nova;
- migració completa, sense tornar a escriure en una segona lectura;
- fallada a cada pas (llegir, escriure, verificar, esborrar), cadascuna amb
  el seu reintent a la propera engegada;
- migració anterior parcial, amb entrades iguals i diferents;
- `store` i `delete` durant la transició;
- l'escombrada d'engegada i els seus recomptes;
- lectures concurrents i un `store` concurrent amb una migració;
- cap valor secret als missatges de registre ni als errors.
