# ADR-0052: Noms i grups de contactes

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-19 de la paritat amb eM Client 10.4 (#41),
  «Contactes → General». La llibreta local, l'edició a CardDAV que mai no
  trepitja un canvi remot ni perd camps (ADR-0012), la importació i
  exportació de vCard i els enllaços de duplicats ja estaven resolts i
  provats; faltaven com es mostren i s'ordenen els noms, i els grups.

## Decisió

- **Parts del nom:**
  - una persona desa, a més del seu nom sencer (`FN`), el nom de pila
    i el cognom quan la llibreta els té separats: el `N` d'una
    vCard (cognom;nom;…), `givenName`/`familyName` de Google, o els dos
    camps nous «Nom» i «Cognoms» de l'editor. Columnes `given` i
    `family` a `people` (esquema 60);
  - un nom que només existeix sencer **mai no es parteix** endevinant: «María
    José García López» o «Kim Min-jun» es mostren tal com són, amb qualsevol
    preferència;
  - en desar a CardDAV, canviar les parts reescriu només el cognom i
    el nom de `N` i conserva segons noms, prefixos i sufixos; una
    targeta sense `N` el rep. Canviar només el nom sencer fa el que feia
    abans (`N:;nombre;;;`), perquè les parts velles ja no el descriuen;
  - un editor que no envia parts (una finestra antiga, el mòbil) les deixa
    com estaven en lloc d'esborrar-les; un contacte escrit només amb les seves
    dues parts rep un nom sencer format amb aquestes.
- **Preferències** (dues files de `settings`, text pla perquè el mòbil
  les llegeixi amb `app.prefsGet`):
  - `contact_name_display`: `auto`, `first_last` («Ada Lovelace»),
    `last_comma_first` («Lovelace, Ada») o `last_first` («Lovelace Ada»;
    per al xinès, el japonès i el coreà sense espai: «王芳»);
  - `contact_name_sort`: `auto`, `first` o `last`. Ordena per la part
    triada i, sense aquesta, pel nom sencer; amb `Intl.Collator` de
    l'idioma de la interfície;
  - `auto` segueix l'idioma de la interfície: cognom primer i ordre per
    cognom en xinès, japonès, coreà, hongarès i vietnamita (ordre de
    CLDR); nom primer i ordre per nom a la resta. L'opció ho diu
    amb un exemple («Com l'idioma (Ada Lovelace)»);
  - s'apliquen a la llista i la fitxa de contactes, als suggeriments de
    destinataris que venen de la llibreta, i a la llista de correu **només
    quan el missatge no porta nom**: llavors es mostra el de la llibreta
    (`people.names`, una consulta agrupada per pantalla). Un nom escrit
    en una capçalera mai no es reescriu; tampoc el d'una adreça vista
    només al correu;
  - a Paràmetres, grup «Contactes» (secció `contactsGeneral`, també a la
    cerca de paràmetres).
- **Grups:**
  - un grup pertany a un llibre, com una persona (`contact_groups` i
    `contact_group_members`, esquema 60), i desa els seus membres per id de
    persona. En un llibre sincronitzat aquest id surt de l'UID del membre al
    mateix llibre, així que una sincronització que reescriu les persones no
    deixa el grup sense elles. Un membre sense targeta aquí no es llista, però
    continua al grup;
  - **local:** crear, canviar el nom, suprimir i posar o treure membres, amb la
    versió amb què es va llegir (ADR-0012): una versió diferent no desa res
    i ho diu. Un grup local pot tenir qualsevol persona de qualsevol llibre: és
    una llista de la persona i ningú més no la llegeix. Suprimir un grup no
    suprimeix ningú; suprimir una persona la treu dels seus grups;
  - **CardDAV:** es llegeixen els dos models que es fan servir: vCard 4
    (`KIND:group` i `MEMBER:urn:uuid:<uid>`) i el d'Apple per a 3.0
    (`X-ADDRESSBOOKSERVER-KIND:group` i `X-ADDRESSBOOKSERVER-MEMBER`). Una
    targeta de grup ja no apareix com a persona;
  - un canvi s'escriu com la resta de targetes (ADR-0012): es llegeix la del
    servidor, es compara la seva ETag amb la versió llegida i s'escriu amb
    `If-Match`; un 412 o una ETag diferent no escriu res i retorna la
    còpia del servidor. El canvi parteix d'aquesta còpia i toca només el nom i
    els membres afegits o trets (diferència amb el que s'ha llegit): un membre
    `mailto:`, un UID que no és en aquest llibre, camps desconeguts i
    l'ordre de les línies tornen tal com eren;
  - un membre nou s'escriu a la propietat que ja fa servir la targeta; un
    grup nou, com els grups que ja té el llibre, i si no en té
    cap, en vCard 4 si les seves targetes són 4.0 i a l'estil d'Apple si són
    3.0 (ho calcula cada sincronització: `contact_sources.group_style`);
  - un grup en un servidor només pot contenir persones d'aquest mateix llibre;
    demanar una altra cosa és un error que no envia res;
  - **Google:** les etiquetes es llegeixen, sense poder-les canviar: el permís
    `contacts.readonly` que ja demana el compte n'hi ha prou per a
    `contactGroups.list` i per a `memberships` de cada persona. Només les de
    l'usuari (`USER_CONTACT_GROUP`); «Els meus contactes», «Destacats» i la
    resta de sistema no són grups que algú hagi triat. Si les etiquetes no es
    poden llegir, les persones se sincronitzen igualment i es conserven els
    grups que hi havia;
  - **Exchange:** sense grups de moment (vegeu «Pendent»).
- **Visualització de contactes:** un selector «Mostrar el grup» filtra la llista
  (amb el nombre de membres), i des d'aquest es crea, es canvia el nom, se
  suprimeix i s'escriu a tot el grup. La fitxa d'una persona mostra els seus
  grups i permet afegir-la a un grup del seu llibre o a un de local, o
  treure-la, quan el grup es pot escriure.
- **Redactor:** escriure part del nom d'un grup el suggereix per sobre de
  les persones, amb quantes adreces té («grup, 3 persones»), i només
  en triar-lo es converteix en la primera adreça de cada membre (cadascuna
  una vegada, amb el seu nom en l'ordre triat); qui no té adreça no
  compta. Els grups es llegeixen la primera vegada que s'escriu en un camp.
- **Mòbil:** la llista de contactes llegeix `contact_name_display` i
  `contact_name_sort` en obrir-se i els aplica a la llista, la fitxa i la
  confirmació de supressió. `auto` mostra el nom sencer i deixa l'ordre
  del nucli, perquè el codi comú no té ordre de noms per idioma.
  Els grups encara no són al mòbil.
- **Baixes:** en treure un compte se'n van els seus grups i els seus membres
  (`REMOVED_WITH_ACCOUNT`); en treure un llibre, els seus grups.

## Alternatives descartades

- **Partir el nom sencer per l'últim espai:** és el que fan altres
  clients i falla amb cognoms compostos, noms d'una sola paraula i
  l'ordre de l'Àsia oriental. Millor mostrar el nom com és.
- **Reescriure amb el nom de la llibreta tots els remitents de la llista
  de correu:** canviaria el que el remitent va dir de si mateix i amagaria
  suplantacions; només s'emplena el que el missatge va deixar buit.
- **Desar en un grup CardDAV la llista completa de membres i escriure-la
  sencera:** perdria els membres que aquí no es veuen (un altre llibre,
  `mailto:`) i la feina d'un altre client entre lectura i escriptura; per
  això s'envia la diferència sobre la còpia del servidor.
- **Escriure sempre vCard 4:** molts servidors i clients de 3.0 (macOS,
  iOS, Nextcloud) només entenen els grups d'Apple; se segueix el que el
  llibre ja fa servir.
- **Categories (`CATEGORIES`) com a grups:** és un altre model, que no
  comparteixen Apple ni RFC 6350 per a grups, i barrejaria etiquetes lliures
  amb llistes; es conserven intactes.
- **Demanar el permís d'escriptura de Google per a editar etiquetes:** obliga
  tots els comptes a tornar a donar permís; queda per a quan es demani.

## Pendent (#41 continua oberta)

- Editar etiquetes de Google i grups d'Exchange (llistes de distribució
  personals). Les llistes d'Exchange ja es llegeixen i s'escriuen (ADR-0058).
- Grups al mòbil i a la importació i exportació de vCard.
- Més camps del contacte (adreces postals, aniversaris) a l'editor.
- Evidència amb proveïdors reals (iCloud, Nextcloud, Google); la prova
  d'integració fa servir Radicale 3.5.4.
