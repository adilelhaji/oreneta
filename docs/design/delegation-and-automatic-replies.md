# Bústies delegades i respostes automàtiques (#48)

Verificació del comportament actual. Separa el que es comprova en el codi i les
proves del que necessita comptes delegats reals.

## Bústies compartides

- **Credencials.** Una bústia compartida es desa com un compte normal amb
  `delegate_account_id` i `target_mailbox`, i una contrasenya buida
  (`account.addSharedMailbox`). Quan es fa servir, pren en memòria les
  credencials del compte delegat (`resolve_delegate`). La contrasenya del
  delegat no es copia mai a la bústia compartida ni a la seva entrada del
  clauer.
- **Sense credencials del delegat.** Si el delegat no té un secret propi o no és
  d'Exchange, la bústia no es resol i s'informa que cal tornar a connectar el
  compte delegat. Ho cobreixen les proves `resolve_delegate` d'`engine.rs`.
- **Graph.** Les bústies compartides continuen sense suport. L'autorització de
  Graph les rebutja en començar (`graph.authBegin`), i el remitent només pot ser
  el compte o un àlies desat.
- **Necessita comptes reals.** Falta verificar:
  - accés complet davant d'«Envia com a» i «Envia en nom de»;
  - on queda la còpia enviada (la bústia compartida o la del delegat);
  - què veu l'usuari quan l'administrador retira el permís.
  Es farà amb comptes delegats de prova autoritzats (#98, files de
  `provider-acceptance-matrix.json`).

## Respostes automàtiques

- **Exchange.** Fa servir les respostes automàtiques del servidor
  (`GetUserOofSettings`/`SetUserOofSettings`), que funcionen amb l'Oreneta
  tancat.
- **IMAP/SMTP.** No hi ha cap mecanisme de servidor. La resposta local només
  funciona amb l'Oreneta obert, i la Configuració ho indica («només mentre
  l'Oreneta s'executa»).
- **Què no rep resposta.** La resposta local no respon:
  - a si mateixa;
  - a adreces `noreply` i `donotreply`;
  - a altres respostes automàtiques (`Auto-Submitted` diferent de `no`);
  - a correu massiu o de llista (`Precedence` bulk/list/junk, `List-Id`,
    `List-Unsubscribe`).
  Respon una vegada per remitent i marca la seva resposta amb
  `Auto-Submitted: auto-replied`.

### Corregit en aquest lliurament

- **Rebots.** Un rebot (`Return-Path: <>`, remitent `MAILER-DAEMON` o
  `postmaster`, `multipart/report`) rebia resposta. Amb el rebot d'aquesta
  resposta començava un bucle amb el servidor. Ara no es respon (RFC 3834 §2).
- **`X-Auto-Response-Suppress`.** La capçalera amb `OOF` o `All`, que fan
  servir Outlook i Exchange, ara es respecta. Si només suprimeix confirmacions
  de lectura, sí que es respon.
- **`List-Post`.** Una llista que només s'identifica per aquesta capçalera ja no
  rep resposta.
- **Dates.** Afectava IMAP i Exchange:
  - la data triada es mostrava en UTC, de manera que a l'est d'UTC apareixia el
    dia anterior;
  - la data final es desava com l'inici d'aquell dia, de manera que «fins al
    12» acabava en començar el 12.
  Ara el dia es llegeix en hora local i el final inclou el dia sencer, també en
  el canvi d'hora (25 hores).

## Proves

- `oof.rs`: rebots per camí nul, per remitent i per `multipart/report`;
  supressió per `OOF` i `All`, i no per confirmacions de lectura; llista per
  `List-Post`; a més dels casos que ja existien.
- `OofSettingsCard.test.tsx`: el dia triat es mostra igual a Madrid, Los
  Angeles, Tòquio i UTC; la data final inclou tot el dia local; un dia de canvi
  d'hora dura 25 hores; una data buida no limita.

## Pendent

- **Comptes reals.** Tota la verificació amb comptes delegats reals: «Envia com
  a», «en nom de», còpia enviada i retirada del permís.
- **Graph.** Les variants de Graph de bústies compartides i respostes
  automàtiques necessiten permisos propis (`Mail.Read.Shared`,
  `MailboxSettings.ReadWrite`), que són una ampliació de l'ADR-0004.
