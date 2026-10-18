# Recuperació del correu sortint sense reintents a cegues (#29)

Contracte d'implementació del primer tram de #29. Cobreix l'enviament immediat,
l'enviament programat i «envia ara» des de l'escriptori amb SMTP i EWS. Encara no
cobreix el camí mòbil (`send_mobile_message`), que continua fent servir
`smtp::send` sense registre durador, ni promet un lliurament exactament una
vegada.

## Tres resultats, no dos

Un enviament SMTP acaba d'una de tres maneres i el motor les distingeix per fase
a `smtp::submit`:

| Fase | Fallada | Classificació | Què vol dir |
|---|---|---|---|
| Connexió, EHLO, AUTH, `MAIL FROM`, `RCPT TO`, `DATA` | qualsevol | **rebutjat** | No s'ha transmès cap byte del missatge; tornar-ho a provar és segur |
| Després de `354`, durant la transmissió del cos | error d'E/S o temps esgotat | **incert** | El servidor pot tenir el missatge complet |
| Resposta final al terminador `.` | `4xx`/`5xx` | **rebutjat** | El servidor ha respost que no |
| Resposta final al terminador `.` | sense resposta, connexió perduda, resposta il·legible | **incert** | L'RFC 5321 permet que el servidor l'hagi acceptat sense que la resposta arribés |

El cos s'envia amb l'escriptor d'ordres del flux (stream), amb dot-stuffing
propi, perquè la crida única `send` de la biblioteca no informa en quina fase ha
fallat. Un missatge que no és UTF-8 vàlid torna a aquesta crida única i tota
fallada posterior a la connexió es classifica com a incerta, per prudència.

Per a EWS no hi ha fase de dades: un error d'E/S o de temps esgotat després
d'enviar la petició és incert; un error SOAP (fault) o un estat HTTP de rebuig, rebutjat.

El marcador `smtp::UncertainSend` viatja com a context `anyhow`; `is_uncertain`
el detecta mitjançant `downcast_ref`, que travessa contextos imbricats.

## Registre durador `outgoing_attempts`

Cada enviament s'escriu a la base de dades **abans** del primer byte i
s'actualitza en acabar. Identificador: l'`id` de la fila programada per als
enviaments programats; el `Message-ID` del missatge per als enviaments immediats
(el client el genera abans d'enviar). La càrrega desada és la petició completa
sense `passphrase`.

```text
sending ─┬─> accepted ──> archived
         ├─> rejected
         └─> uncertain ──> resolved
```

- `accepted` amb `archive_error` és un missatge enviat sense còpia a Enviats.
  Continua sent enviat: no es presenta mai com a «no enviat».
- En arrencar, tota fila en `sending` passa a `uncertain` amb un motiu explícit:
  el procés va morir amb l'enviament en curs.
- `uncertain` només el tanca una persona (`mail.resolveOutgoing`). El motor no
  el torna a provar ni el descarta.
- L'historial tancat (`rejected`, `archived`, `resolved`, `accepted` sense
  error d'arxivament) es poda als 30 dies. Un intent incert no es poda mai.

## Proteccions contra el reenviament a cegues

- `send` amb un `attempt_id` l'intent anterior del qual pugui haver arribat
  (`sending`, `accepted`, `archived`, `uncertain`) retorna
  `{ok:false, outcome:"already_attempted"}` tret que la petició porti
  `resend:true`. Això també protegeix davant d'una interfície que torni a provar.
- El bucle dels programats consulta l'intent abans d'enviar: `accepted` o
  `archived` → la fila s'esborra i s'anuncia com a enviada (H03 corregit);
  `uncertain` o `sending` → la fila es deixa d'intentar i s'anuncia amb
  `uncertain:true`; `rejected` o inexistent → s'envia.
- Un resultat incert d'un programat no consumeix reintents amb espera
  exponencial (backoff): s'atura immediatament. «Envia ara» sobre aquesta fila
  exigeix `resend:true`.

## Interfície

- `mail.send` retorna `{ok, outcome, attempt_id, error}`; `outcome` és
  `archived`, `accepted`, `uncertain` o `already_attempted`. Un rebuig continua
  sent un error.
- Bombolla de resposta ràpida: estat `uncertain` amb un botó que obre
  «Pendents d'enviar»; «Torna-ho a provar» no actua sobre aquest estat.
- Editor complet: `UncertainSendError` en línia; l'editor queda obert amb
  el seu contingut i l'intent apareix a la llista.
- «Pendents d'enviar» llista els intents sense resoldre amb dues accions:
  «Torna a enviar» (adverteix de la possible duplicació i envia amb
  `resend:true`) i «Marca com a resolt». Els programats amb resultat
  desconegut mostren la mateixa advertència i reenvien amb `resend:true`.
- En resoldre o reenviar amb èxit, la bombolla corresponent passa a enviada.

## Límits declarats

- No hi ha desduplicació per `Message-ID` al servidor ni garantia de lliurament
  únic; el document només evita que el client dupliqui pel seu compte.
- Un missatge signat amb una clau protegida per contrasenya no es pot reenviar
  des de la llista (la contrasenya no es desa); cal redactar-lo de nou.
- La restauració després d'un reinici recupera el contingut, els destinataris, la
  identitat i els adjunts de l'intent a partir de la base de dades; no recupera
  l'editor obert (#170).
- Les proves amb un servidor SMTP fals i amb maddy acrediten la classificació i la
  protecció contra duplicats de manera aïllada; no certifiquen proveïdors reals.

## Verificació

- Rust: `smtp::tests` (connexió perduda després del cos, rebuig després del cos,
  destinatari rebutjat sense transmetre dades, dot-stuffing), `store::outgoing`
  (transicions, arrencada, poda, resolució) i `scheduled_send_precheck`.
- Go: pas del resultat pel pont, reenviament deliberat, gestors nous;
  integració amb maddy: segon `send` amb el mateix `Message-ID` rebutjat com a
  `already_attempted` amb una sola còpia lliurada, i lliurat amb `resend`.
- Frontend: `outgoingAttempts.test.ts`, casos de `compose.test.ts`,
  `scheduledSends.test.ts` i `MessageBubble.test.tsx`.
