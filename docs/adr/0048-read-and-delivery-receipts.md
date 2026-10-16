# ADR-0048: Confirmacions de lectura i de lliurament

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-11 de la paritat amb eM Client 10.4 (#107), «Correu →
  Privadesa / Confirmacions». El bloqueig de contingut remot i la
  protecció contra rastrejadors (ADR-0029) ja existien; faltava què fer
  amb les confirmacions: demanar-les en enviar i respondre les que demanen
  els missatges rebuts.

## Decisió

- **Demanar confirmacions en enviar:**
  - el redactor té dos interruptors, «Demanar confirmació de lectura» i
    «Demanar confirmació de lliurament», que comencen amb el que s'ha triat a
    Paràmetres → Confirmacions (tots dos desactivats per defecte; paràmetre global,
    no per compte);
  - la de lectura és la capçalera `Disposition-Notification-To` amb
    l'adreça del remitent (RFC 8098 §2.1). S'escriu sobre el missatge ja
    construït i abans de signar o xifrar, de manera que una signatura la cobreix; la
    còpia d'Enviats també la porta. Va igual per SMTP que per Exchange
    (EWS) i Microsoft Graph, que llegeixen la capçalera del MIME que se'ls
    lliura;
  - la de lliurament es demana al servidor per SMTP (DSN, RFC 3461):
    `RET=HDRS` a `MAIL FROM` i `NOTIFY=SUCCESS,FAILURE` amb
    `ORCPT=rfc822;<dirección>` a cada `RCPT TO`. Només si el servidor
    anuncia `DSN` en la seva resposta a `EHLO` (que es repeteix abans
    d'autenticar, perquè la biblioteca no conserva aquesta extensió). Si no
    l'anuncia, el missatge surt igual, sense la petició, i l'enviament respon
    `delivery_receipt: "unsupported"`; el redactor ho diu en confirmar
    l'enviament. Sense demanar-la, a la connexió no canvia res;
  - un enviament programat desa les dues peticions amb la resta del
    missatge.
- **Respondre les que demanen els missatges rebuts:**
  - en llegir un missatge, el nucli n'extreu la petició
    (`Disposition-Notification-To`, `Return-Path`, si ve d'una llista
    —`List-Id`, `List-Post`, `List-Unsubscribe` o `Precedence`
    bulk/list/junk— i `Original-Recipient`) i la desa amb el missatge a la
    memòria cau. Un informe (`multipart/report`) no es respon mai. La vista
    només rep `receipt_requested`;
  - la política es tria a Paràmetres: «Preguntar cada vegada» (per defecte),
    «Enviar sempre» o «No enviar mai». Es desa al paràmetre
    `read_receipt_policy`, que llegeix el nucli; un valor desconegut compta
    com a «preguntar»;
  - la decisió és una funció pura (`receipts::decide`), en aquest ordre:
    sense petició, res; ja respost, res més; sense Message-ID, silenci
    (no es podria recordar ni anomenar); a Correu brossa, silenci
    sempre (respondre confirmaria que l'adreça funciona); «mai»,
    silenci; si ve d'una llista, o la confirmació aniria a un domini
    diferent del de `Return-Path` (o no hi ha `Return-Path`), es pregunta
    encara que la política sigui «sempre» (RFC 8098 §2.1); si no, «sempre»
    envia sense preguntar i «preguntar» pregunta;
  - preguntar és una barra que no bloqueja, damunt del cos: «El remitent
    ha demanat que l'avisessis quan llegissis això. Enviar confirmació / No
    enviar», amb el motiu de precaució quan n'hi ha. No respondre no
    envia res;
  - la resposta, sigui quina sigui, es recorda per compte i Message-ID
    (`receipt_answers`, esquema 59) i no es torna a preguntar. S'esborra
    amb el compte;
  - abans d'enviar es reclama la fila (`INSERT OR IGNORE`), així dues
    lectures del mateix missatge no envien dues confirmacions. Si el servidor
    rebutja l'enviament, la fila s'allibera i es pot tornar a preguntar; si
    el resultat és dubtós (s'ha lliurat i no hi ha hagut resposta), es queda com a
    enviada, per no enviar-ne una segona.
- **La confirmació que s'envia** es construeix al nucli
  (`receipts::build_mdn`): `multipart/report;
  report-type=disposition-notification` amb una part de text per a la
  persona i la part `message/disposition-notification` (en 7bit, mai
  quoted-printable ni base64) amb `Reporting-UA: Oreneta` (sense versió ni
  nom d'equip), `Original-Recipient` si el missatge el portava,
  `Final-Recipient: rfc822;<dirección propia>`, `Original-Message-ID` i
  `Disposition: manual-action/MDN-sent-manually; displayed` o
  `automatic-action/MDN-sent-automatically; displayed`. Assumpte
  «Read: …», `In-Reply-To` i `References` a l'original; l'automàtica
  porta a més `Auto-Submitted: auto-replied` (RFC 3834). Els camps
  llargs es pleguen en espais; noms i assumptes no ASCII van com a
  paraules codificades. Si alguna adreça no és ASCII es fa servir
  `message/global-disposition-notification` en 8bit (RFC 6533).
- **S'envia pel compte que ha rebut el missatge**, des de l'adreça
  pròpia a la qual anava adreçat (o la principal), pel seu servidor SMTP o
  per Exchange/Graph, a les adreces de la petició. No se'n desa
  còpia a Enviats, com la resposta de fora de l'oficina.
- **Res no surt sense la persona:** només el seu clic o la seva elecció explícita de
  «sempre». És la mateixa idea que la protecció contra rastrejadors: una
  confirmació diu que has obert el missatge i quan, que és justament el que
  un píxel de seguiment intenta esbrinar. La pàgina de privadesa ho
  diu a la seva fila.

## Alternatives descartades

- **`MAIL FROM:<>` (remitent nul) per a la confirmació,** com suggereix
  RFC 8098 §3: molts servidors d'enviament autenticat el rebutgen o el
  reescriuen. Es fa servir l'adreça del compte; `Auto-Submitted` evita els
  bucles en l'automàtica.
- **Preguntar també a Correu brossa:** respondre a correu brossa
  confirma l'adreça; si el missatge en surt, es pregunta llavors.
- **Tornar a demanar el missatge sencer al servidor per llegir les capçaleres
  cada vegada que s'obre:** seria una baixada per missatge obert. La
  petició s'extreu en analitzar el cos i es desa amb ell.
- **Demanar confirmació de lliurament a Exchange o Graph per capçaleres MIME
  (`Return-Receipt-To`):** no és un estàndard i no hi ha manera de saber si es
  respecta; es diu que no està disponible en comptes de prometre-ho.

## Pendent

- **Confirmació de lliurament a EWS i Graph:** fet. A EWS es demana en el
  mateix element, al costat del MIME (`IsDeliveryReceiptRequested`, ADR-0058);
  falta l'evidència amb un servidor real. A Graph es demana des d'ADR-0057
  sobre un esborrany, només en comptes amb canvis i, de moment, sense còpia oculta ni
  signatura o xifratge; si no, respon «unsupported» amb el motiu.
- **Missatges a la memòria cau d'abans d'aquesta versió:** no tenen la petició
  desada i no mostren la barra fins que es tornen a baixar. No
  s'invalida tota la memòria cau per això.
- **Missatges de Graph llegits sense MIME:** si la lectura no passa per
  l'analitzador MIME, no es veu la petició (`isReadReceiptRequested` del
  recurs encara no es llegeix).
- **Interpretar les confirmacions i els avisos de lliurament rebuts** (mostrar
  el que diuen al missatge enviat): fet a ADR-0057 (#210). Es vinculen
  quan l'informe es llegeix (a Graph, en sincronitzar; a IMAP i EWS, quan
  el seu cos es baixa o s'obre); els desats a la memòria cau abans d'aquella
  versió només es vinculen si es tornen a llegir.
- **Prova amb servidor real:** el maddy 0.8 de la integració no anuncia
  DSN, de manera que la prova comprova que la de lliurament s'informa com a no
  disponible i que la de lectura arriba de bob a alice després del seu clic. Un
  servidor amb DSN (Postfix) cobriria el camí `requested`.
- Un paràmetre per compte en lloc de global, si algú ho demana.
