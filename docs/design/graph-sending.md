# Enviament per Microsoft Graph (#143)

Sota l'[ADR-0004](../adr/0004-microsoft-graph.md), que autoritza `Mail.Send` com
a permís a part, i sobre el contracte persistent d'enviament de #29
([outgoing-mail-recovery.md](outgoing-mail-recovery.md)). No hi ha persistència
nova: cada enviament de Graph és un intent a `outgoing_attempts`, amb els
mateixos estats i la mateixa recuperació que SMTP i EWS.

## Permís

- **Sol·licitud a part.** «Permet l'enviament» a la configuració del compte
  demana `Mail.Send` per a aquell compte. Si el compte ja tenia
  `Mail.ReadWrite`, es torna a demanar, per no perdre'l.
- **Mana el que s'ha concedit.** El marcador no secret desa
  `{"writes": bool, "send": bool}` segons el que ha retornat Microsoft.
- **Renovació.** Demana el mateix conjunt que es tenia. Si s'ha retirat el
  consentiment, passa una vegada a només lectura.
- **Remitent.** Només el compte amb la sessió iniciada. Les bústies
  compartides, «envia com a» i la delegació queden a #48: el nucli rebutja
  qualsevol remitent que no sigui l'adreça del compte o un àlies desat, com
  fins ara.

## Enviament

- **El mateix MIME.** Es construeix amb `smtp::build_submission`, el mateix que
  fa servir Exchange:
  - text i HTML, adjunts i imatges en línia per `cid:`;
  - `Bcc` a les capçaleres, que el servidor treu abans de lliurar;
  - signatura o xifratge aplicats igual que a SMTP. Si no es poden aplicar, no
    s'envia.
- **Sol·licitud.** `POST /me/sendMail` amb el MIME en base64
  (`Content-Type: text/plain`). Microsoft desa la còpia a Elements enviats; la
  sincronització següent la porta.
- **Confirmació de lliurament** ([ADR-0057](../adr/0057-graph-folder-moves-and-receipt-reports.md)):
  - `sendMail` amb MIME no la pot portar: és la propietat
    `isDeliveryReceiptRequested` del missatge. Quan es demana i el compte té
    canvis (`Mail.ReadWrite`) a més d'enviament, el mateix MIME es converteix
    en esborrany (`POST /me/messages`), es marca (`PATCH`) i s'envia
    (`POST /me/messages/{id}/send`, 202);
  - només per a un missatge **sense Cco i sense signatura ni xifratge**: fins
    que un inquilí real no demostri que l'esborrany fet a partir del MIME
    conserva els Cco i la protecció, perdre'ls seria silenciós;
  - sense demanar-la, s'envia com sempre per `sendMail` (`"none"`). Demanada
    però sense canvis, amb Cco o protegit, també per `sendMail`, amb
    `delivery_receipt: "unsupported"` i `delivery_receipt_reason`
    (`needsChanges`, `bcc`, `protected`), que el redactor explica;
  - un error en crear o marcar l'esborrany és «no enviat»: se suprimeix
    l'esborrany i l'intent queda rebutjat, mai incert; si podia haver quedat
    una còpia a Esborranys (sense resposta, 5xx o resposta il·legible en
    crear-lo, o no s'ha pogut suprimir), s'indica;
  - l'enviament de l'esborrany segueix la taula de sota. Un incert indica a més
    que pot quedar una còpia a Esborranys; un rebuig suprimeix l'esborrany;
  - mentre dura l'enviament, l'esborrany es pot veure a Esborranys des d'altres
    clients. Si l'aplicació es tanca entre crear-lo i enviar-lo, s'hi queda i
    l'intent continua obert a `outgoing_attempts` (#29), perquè la persona el
    resolgui.
- **Límit.** El cos de la sol·licitud admet fins a 4 MB. Un missatge més gran es
  rebutja abans d'enviar-lo, amb «massa gran per enviar-lo per Microsoft
  Graph». És un rebuig definitiu i no s'ha enviat res. Pujar-lo per sessions de
  càrrega necessitaria esborranys al servidor i queda fora d'abast.
- **Esborranys al servidor.** Els comptes de Graph no desen esborranys al
  servidor en aquest lliurament. El redactor no ho intenta i l'esborrany es
  conserva al magatzem local de #170.
- **Resposta ràpida.** A IMAP, el text d'una resposta ràpida torna quan es
  torna al fil gràcies al seu esborrany al servidor. A Graph no hi ha aquest
  esborrany, de manera que es desa en memòria per fil en sortir i es restitueix
  en tornar; sense això es perdria en canviar de conversa. Sobreviu mentre
  l'aplicació és oberta, no a un reinici.

## Resultats

Cada estat es distingeix com a #29:

| Resposta | Estat | Reintent |
|---|---|---|
| 202 | `accepted` (acceptat per al lliurament; no és confirmació de lliurament) | — |
| 400, 401, 403, 404, 413, 429 | `rejected` amb el motiu (la sol·licitud no s'ha acceptat) | Només expressament |
| Massa gran abans d'enviar | `rejected` | Només expressament, després de reduir-lo |
| Connexió perduda després d'enviar, temps esgotat, 5xx | `uncertain` | Mai automàtic |
| Un altre 2xx o resposta il·legible després d'enviar (#210) | `uncertain` | Mai automàtic |

- **Incert.** Un 5xx o un 504 poden arribar després que Microsoft hagi acceptat
  l'enviament, de manera que no es prenen com a rebuig.
  - L'intent incert no es reintenta en arrencar ni enlloc més.
  - La interfície ofereix «Torna a enviar» o «Marca com a resolt».
  - Tornar a enviar una cosa ja intentada exigeix `resend`, com a SMTP.
- **Doble activació.** Prémer enviar dues vegades sobre el mateix `Message-ID`
  troba l'intent anterior i s'atura.
- **Cancel·lació.** El «desfés l'enviament» passa abans de cridar el nucli, de
  manera que no arriba mai a Graph.
- **Enviament programat.** Els comptes de Graph encara no en tenen.

## Proves

- **Transport** (servidor de bucle local):
  - camí, capçaleres, `text/plain` i cos en base64 que es descodifica al MIME;
  - 202 acceptat;
  - 4xx rebutjat amb categoria, 429 amb la seva espera i 5xx;
  - connexió perduda com a incerta, enviada una sola vegada;
  - mida excedida rebutjada sense enviar res;
  - una concessió sense `Mail.Send` no envia res;
  - confirmació de lliurament: esborrany a partir del MIME, `PATCH` amb
    `isDeliveryReceiptRequested` i enviament sense cos; sense
    `Mail.ReadWrite` no es crea l'esborrany (#210).
- **Autorització:** flux d'enviament amb el conjunt demanat, nivell concedit al
  marcador i renovació que conserva `Mail.Send`.
- **Nucli:** el guardià només deixa passar `send` amb el permís; la
  classificació dels errors de Graph en incert o rebutjat; la confirmació de
  lliurament es demana exactament quan la política ho diu, i un error abans
  d'enviar és un rebuig (#210).
- **Interfície:**
  - un compte de Graph amb permís d'enviament es pot triar com a remitent;
  - sense permís, no;
  - els seus esborranys no es desen al servidor.
- **Fora d'aquestes proves:** el lliurament real amb destinataris dedicats i
  autoritzats és evidència de proveïdor (#98), no d'aquestes proves.
