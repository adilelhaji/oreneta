# Redacció sense errors silenciosos (#39)

Part de #39 lliurada a la iteració 2. La recuperació completa d'esborranys
(#170) té el seu propi contracte a
[editor-draft-recovery.md](editor-draft-recovery.md).

## Errors reproduïts

- **Noms amb coma.** L'editor ja llegia bé `"Doe, John" <j@x.com>`, però tres
  camins no:
  - la llista d'adreces de les respostes (`splitAddressList`) es partia per
    cada coma. Respondre a tothom amb l'adreça pròpia entre cometes a Cc
    deixava un fragment `"Me` com a destinatari;
  - respondre a un remitent anomenat `Doe, John` escrivia
    `Doe, John <j@x.com>` sense cometes, i el mateix editor ho llegia com a dues
    entrades, una de les quals no vàlida;
  - acceptar del desplegable un contacte anomenat `Doe, John` produïa les
    mateixes dues entrades.
- **Diàleg «sense assumpte» fix en anglès.**

## Contracte

- **Llista d'adreces.** Es divideix amb el mateix analitzador de l'editor: les
  comes i els punts i comes separen, excepte dins de cometes o de `<…>`.
- **Noms en escriure una adreça.** Un nom amb `, ; < > "` es posa entre cometes
  i s'escapa en construir la resposta i en acceptar un contacte.
- **Duplicats.** Un destinatari repetit no s'afegeix dues vegades al camp. El
  nucli ja elimina els duplicats del sobre SMTP.
- **Identitat.** El nucli només envia des de l'adreça del compte, el seu usuari
  d'inici de sessió o un àlies desat (`store::resolve_send_from`), i rebutja
  qualsevol altra adreça amb un error que l'anomena. El selector «De» mostra el
  compte o l'àlies triat. No canvia en aquest lliurament.
- **Avís d'adjunt oblidat.** L'avís salta si l'assumpte o el text propi del
  missatge mencionen un adjunt i no hi ha cap fitxer adjunt. Les imatges
  inserides al cos no compten com a adjunt. Abans d'enviar es pregunta una
  vegada; «Torna» deixa l'esborrany intacte i «Envia igualment» l'envia. No
  bloqueja mai només per una paraula.
  - **On.** Funciona a l'editor complet i a la resposta ràpida.
  - **Paraules.** Són arrels desades a cada catàleg d'idioma
    (`composer.attachmentReminder.keywords`), sempre juntament amb les
    angleses.
  - **Com es cerca.** En alfabets amb espais, l'arrel ha de començar una
    paraula: «reattached» no compta. En xinès, japonès, coreà i àrab es cerca
    en qualsevol posició.
  - **Citacions.** No compta el text citat: línies `>` i `<blockquote>`.

## Proves

- `lib/address.test.ts` i `states/replyRecipients.test.ts` cobreixen la divisió
  amb cometes i punts i comes. També la resposta, la resposta a tothom amb
  l'adreça pròpia entre cometes, `Reply-To` amb un nom entre cometes, l'àlies
  darrere d'un nom entre cometes i el contacte del desplegable. Els casos de
  resposta, resposta a tothom i contacte fallaven abans del canvi.
- `lib/attachmentReminder.test.ts` cobreix el cos i l'assumpte, adjunt present,
  imatge inserida, citacions en text i HTML, límits de paraula, idioma més
  anglès, alfabets sense espais, àrab amb article i majúscules amb accents.
- `Composer.test.tsx` comprova l'avís, «Torna» sense enviament i «Envia
  igualment» amb enviament, i que no hi ha avís amb adjunt. `compose.test.ts`
  comprova el mateix a la resposta ràpida.

## Límits

- Les llistes de paraules són arrels senzilles. Una menció amb una altra forma
  («PJ», argot) no avisa, i una paraula homònima, com «Anlage» en alemany, pot
  avisar de més. Per això és un avís i no un bloqueig.
- No hi ha cap opció de configuració per desactivar l'avís.
- No s'ha validat amb comptes reals ni amb el binari natiu.
