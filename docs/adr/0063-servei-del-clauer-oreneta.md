# ADR-0063: Els secrets passen del servei de clauer `meron` a `oreneta`

- Estat: acceptada pel propietari el 2026-10-17 («Acepto el diseño»), revisat
  a la PR #253. Els objectius i els criteris d'acceptació de #248 també són
  del propietari (2026-10-17).
- Data: 2026-10-17.
- Abast: #248, només el nom del servei del clauer i la migració de les
  entrades que ja hi ha.

## Context

El nucli desa els secrets de cada perfil (contrasenyes, testimonis d'OAuth,
la clau de la base SQLCipher, les dades de Graph de cada compte) al clauer del
sistema sota el servei `meron`, el nom heretat. Cada entrada té un nom
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

A iOS, el codi compartit de `pim/` (`people.rs`, `calendar.rs`) també llegeix
`secrets.rs` amb el clauer d'Apple, i ara llegeix `oreneta` i després `meron`.
Al mòbil no hi escriu res: tots els `secrets::store` són al binari
d'escriptori.

Només reanomenar el servei deixaria orfes totes les entrades: cap compte no
trobaria la contrasenya, i la base no s'obriria perquè se'n generaria una
clau nova.

## Decisió

- **Servei nou.** Tot el que s'escriu va al servei `oreneta`
  (`secrets_migration::SERVICE`). `meron` (`LEGACY_SERVICE`) només es llegeix
  i s'esborra. Els noms de les entrades i el format dels valors no canvien.
- **Ordre de consulta.** Primer `oreneta`; si no hi és, `meron`. El valor que
  es retorna és sempre el desat, intacte. Un error en llegir `oreneta` es
  retorna, com abans un error en llegir `meron`: no es pren per «no n'hi ha».
- **Moure una entrada.** Llegir `meron`, escriure el valor a `oreneta`,
  tornar a llegir `oreneta` i comparar-lo byte a byte, i només llavors esborrar
  `meron`. Si la còpia no coincideix o no es pot llegir, s'esborra la còpia
  d'`oreneta` (si no, una còpia defectuosa taparia l'original, perquè `oreneta`
  es llegeix primer) i `meron` es queda com estava. Si tampoc no es pot
  esborrar la còpia, durant la resta de l'execució es llegeix primer `meron`.
- **Quan es mou.**
  - En llegir una entrada per primera vegada a l'execució. Inclou la clau de
    la base, que es llegeix abans d'obrir el magatzem.
  - En engegar, en segon pla, cada nom que el magatzem coneix: la mateixa
    llista que fa servir la purga d'un perfil (`profile_purge::secret_names`,
    vigilada pel recompte de `secrets::store(`), més l'entrada de Graph de
    cada compte (`profile_purge::keychain_names`). Així també es mouen les
    entrades que la sessió no arriba a llegir.
- **Idempotència.** Cada execució torna a mirar les entrades que no ha
  resolt. Segons el que troba:
  - Només a `oreneta`: no fa res.
  - Només a `meron`: la mou.
  - A tots dos llocs i iguals (una execució anterior en va fer la còpia però
    no va poder esborrar l'original): esborra `meron`.
  - A tots dos llocs i diferents: en llegir, no esborra res, fa servir
    `oreneta` i en deixa un avís al registre. El primer `store` d'aquesta entrada ho
    resol (vegeu «Desar un secret»).
  - Enlloc: no hi ha secret, i no s'escriu res.
- **Estat de l'execució, només en memòria.** Per a cada entrada: no mirada,
  resolta (`meron` ja no hi és), ajornada (un pas de lectura o de moviment
  ha fallat), retinguda (un `store` tampoc no l'ha pogut retirar) o no
  verificada (la còpia defectuosa no s'ha pogut esborrar). Una lectura no torna
  a provar el moviment d'una entrada ajornada fins a la propera engegada, i
  mentrestant serveix el valor de `meron`. No es desa cap marca de migració:
  el model de dades no canvia.
- **Desar un secret** (`store`) escriu a `oreneta`. Mentre l'entrada `meron`
  no estigui resolta ni retinguda, es mira si hi és. Si hi és, es torna a
  llegir la nova i, si coincideix amb el valor desat, s'esborra la vella, encara que sigui
  diferent: el seu valor acaba de ser substituït. Es prova una vegada per
  execució. Si la nova es llegeix amb un altre valor, es retorna un error,
  `meron` es conserva i el valor defectuós s'esborra, com en moure una
  entrada (si no es pot esborrar, es llegeix primer `meron`). Si l'escriptura falla, es retorna l'error, com abans,
  i `meron` no es toca.
- **La clau de la base** (`db_key`) es llegeix com qualsevol entrada. Si la
  d'`oreneta` no és vàlida i la de `meron` és bona, es fa servir la de
  `meron` i se'n refà la còpia; si no es pot refer, se n'avisa i es continua
  amb la de `meron`. Només se'n genera una de nova quan cap dels
  dos serveis no en té cap de bona.
- **Esborrar un secret** (`delete`, la supressió d'un compte, la purga d'un
  perfil) esborra primer `meron` i després `oreneta`. Si falla el primer, no
  es toca el segon: mai no queda només una còpia a `meron` que una lectura
  posterior recuperaria.
- **Registre.** Etiqueta `keyring`. Cada pas que falla genera un avís amb el
  nom de l'entrada, el pas i l'error del magatzem. L'escombrada d'engegada
  escriu una línia de recomptes (mogudes, ajornades, il·legibles) quan algun
  recompte no és zero: un avís si alguna s'ha ajornat o no s'ha pogut
  llegir, i una línia informativa si totes s'han mogut. Cada moviment correcte també
  s'anota al nivell d'informació amb el nom de l'entrada (només a les compilacions
  de depuració, les úniques que escriuen aquest nivell). Els noms, adreces
  incloses, ja sortien als errors del clauer d'abans. Els valors no surten
  mai: ni al registre, ni als errors, ni a la sortida de les proves.

### Concurrència

- **Un procés per perfil.** El bloqueig d'instància única i el bloqueig del
  perfil (ADR-0016, ADR-0038) fan que només un procés obri cada perfil. Els
  noms del clauer porten el perfil, i dos perfils no comparteixen cap entrada.
- **Dins del procés**, cada entrada té el seu bloqueig, que serialitza llegir,
  moure, desar i esborrar. Així, la còpia del valor vell no pot sobreescriure
  un testimoni d'OAuth acabat de renovar en un altre fil. Entrades diferents
  no s'esperen entre elles.
- **Tornar a una versió anterior** després del moviment no s'admet.
  La versió anterior no veu `oreneta`: no troba la clau de la base, en genera
  una de nova a `meron` i no pot obrir el magatzem. No es perd res, perquè
  `oreneta` conserva la clau bona.
  En tornar a la versió nova, la clau de la base és a tots dos serveis, amb valors diferents:
  es fa servir `oreneta`, es conserva `meron` i se n'avisa a cada engegada.

### Estats de fallada

| Pas que falla | Què queda | El compte | Nou intent |
|---|---|---|---|
| Llegir `oreneta` | Res escrit ni esborrat; error a qui llegeix | Com abans quan el clauer fallava | Propera lectura |
| Llegir `meron` | Res escrit ni esborrat; error a qui llegeix | Com abans quan el clauer fallava | La lectura, a la propera lectura; el moviment, a la propera engegada |
| Escriure `oreneta` | `meron` intacta | Funciona amb `meron` | Propera engegada |
| Verificar la còpia | La còpia s'esborra; `meron` intacta | Funciona amb `meron` | Propera engegada |
| Esborrar la còpia no verificada | Error al registre; `meron` intacta | Funciona amb `meron` fins al final de l'execució | La propera engegada troba dues entrades diferents (risc acceptat, a sota) |
| Esborrar `meron` | Dues entrades iguals | Funciona amb `oreneta` | La propera engegada, o el proper `store` |
| `store`: retirar `meron` | `oreneta` amb el valor nou; `meron` amb el vell | Funciona amb `oreneta` | El primer `store` d'una engegada posterior |

### Riscos acceptats

- **Doble fallada en moure.** Si la còpia no passa la verificació i tampoc no es pot
  esborrar, la propera engegada troba dues entrades diferents i fa servir
  `oreneta`, que és la defectuosa. No es pot distingir d'un valor més nou sense
  desar una marca. No s'hi perd res: `meron` es conserva, i el primer `store`
  ho resol. Per a la clau de la base, que no sempre torna a passar per
  `store`, una clau no vàlida no tapa mai la bona de `meron`.
- **Entrades que cap lectura no resol.** Una entrada que mai no es torna a
  desar, i que es queda amb dos valors diferents, es conserva a `meron` i en
  genera un avís a cada engegada.
- **Linux sense Secret Service.** Si el Secret Service no respon, el procés
  passa al clauer local (`force_local`). Allà les dues lectures donen «no n'hi
  ha», i la clau de la base es genera de nou. Ja passava abans de #248, i
  aquest canvi no ho resol. Pel mateix motiu, un esborrament de `meron` que cau
  al clauer local no esborra l'entrada del Secret Service.
- **Windows, trossos a mig esborrar.** Si un esborrament anterior de `meron` es
  va aturar entre els trossos i la marca, `meron` no es pot llegir i no
  s'esborra: no s'esborra mai una entrada que no s'ha pogut llegir.
- **Entrades que el magatzem ja no anomena** (esborraments antics fallits,
  perfils que no es tornen a obrir) es queden a `meron`: no es poden
  enumerar per prefix (ADR-0038). El criteri «cap sota `meron`» de #248 val
  per a les entrades que el perfil coneix.

### El que no es fa mai

- Esborrar `meron` abans de comprovar, rellegint-la, que la còpia
  d'`oreneta` és idèntica, o que un `store` hi ha desat el valor que la
  substitueix.
- Esborrar `meron` en llegir, si és diferent d'`oreneta`.
- Generar una clau nova de la base quan el clauer en ús ha retornat un error de
  lectura, o quan `meron` en té una de bona.
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
   de `meron` per entrada en cada engegada, però afegiria estat al model de
   dades i una marca que podria no dir la veritat (un clauer restaurat).
   Rebutjada.
5. **Copiar i esborrar sense rellegir.** Si la còpia sortia truncada o
   fallava, s'esborraria l'únic valor bo. Rebutjada pel requisit de #248.

## Conseqüències

- L'Administrador de credencials, el clauer de macOS i Seahorse mostren
  `oreneta`. Les entrades `meron` desapareixen a mesura que es mouen.
- Cada engegada fa una lectura de `meron` per cada nom que el magatzem
  coneix, també quan ja no n'hi ha cap: no es desa cap marca. És una cerca
  local, sense xarxa.
- macOS: si la identitat del binari ha canviat (#247), el sistema pot demanar
  permís per llegir o esborrar cada entrada `meron`. Si es denega, l'entrada
  es queda a `meron`, i el permís es torna a demanar a cada lectura d'aquesta
  entrada i a cada engegada.

## Verificació

Proves de `meron-core/src/secrets_migration.rs` amb un magatzem de
credencials fals, i les dels mòduls que el fan servir:

| Criteri de #248 | Proves |
|---|---|
| Una instal·lació nova només desa a `oreneta` | `a_fresh_install_writes_only_under_oreneta`; `secrets_portal::tests::keyring_attributes_are_app_scoped`; la clau nova de `the_store_key_moves_and_is_never_minted_on_a_read_error` |
| Un perfil amb `meron` acaba amb els mateixos secrets a `oreneta` i cap a `meron`, sense tornar a connectar | `an_existing_entry_moves_whole_and_the_legacy_one_is_deleted`; `the_start_up_sweep_moves_every_named_entry_and_reports_counts_only`; `profile_purge::tests::the_sweep_names_every_secret_and_each_accounts_graph_record`; `the_store_key_moves_and_is_never_minted_on_a_read_error`; `concurrent_first_reads_move_an_entry_once` |
| Una fallada a qualsevol pas no perd res i es torna a provar | Llegir: `a_failed_oreneta_read_is_an_error_and_touches_nothing`, `a_failed_legacy_read_loses_nothing_and_is_retried`, `a_failed_legacy_check_on_an_already_moved_entry_deletes_nothing`, `the_sweep_logs_and_counts_an_unreadable_entry`. Escriure: `a_failed_write_keeps_the_legacy_entry_serving_and_is_retried_next_start`, `a_failed_store_leaves_the_legacy_entry_alone`. Verificar: `a_copy_that_reads_back_different_is_removed_and_the_original_kept`, `a_copy_that_cannot_be_read_back_is_removed_and_the_original_kept`, `a_damaged_copy_that_cannot_be_removed_never_costs_the_original`, `a_store_that_cannot_be_read_back_keeps_the_legacy_entry`, `a_store_that_reads_back_different_is_an_error_and_keeps_the_legacy_entry`. Esborrar: `a_failed_legacy_delete_is_finished_on_the_next_start`, `a_store_after_a_failed_legacy_delete_retires_it_once_per_run`, `a_delete_removes_both_and_a_failed_legacy_delete_leaves_nothing_to_resurrect`, `a_delete_whose_oreneta_step_fails_never_leaves_a_lone_legacy_copy`. Migració anterior parcial: `a_partial_previous_move_with_different_values_keeps_both_until_a_store`. Clau de la base: `a_malformed_oreneta_store_key_never_hides_the_good_legacy_one`, `a_failed_store_key_repair_still_opens_with_the_legacy_key`. Concurrència: `a_store_during_a_move_is_never_overwritten_by_the_old_value` |
| Cap valor secret al registre ni a la sortida de les proves | `assert_clean` a cada prova, sobre el registre i el text dels errors (els del magatzem fals imiten els reals: nom, sense valor). Els valors es comparen amb `assert!`, que no els imprimeix si falla |

Pendent:
- **Compilació de Windows.** La CI de la PR compila i prova Rust a Linux i
  compila per a macOS (`test.yml`), però no compila el codi propi de Windows. El
  flux `windows-validation.yml` només s'executa a mà, després de la CI de
  `main`: el propietari n'ha demanat una execució després de fusionar.
- **Verificació nativa (N4):**
  - Windows: un perfil amb comptes, inclòs un d'Outlook (blob repartit en
    trossos), passa a `.oreneta` sense tornar a connectar.
  - macOS: el mateix, i comprovar què demana el sistema si la identitat del binari ha
    canviat.
  - Linux: Seahorse mostra les entrades sota `oreneta`.
