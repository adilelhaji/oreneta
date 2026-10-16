# ADR 0004: Adaptador incremental de Microsoft Graph

Estat: Acceptada — 2026-09-09. El mantenidor va aprovar “sí, incorpóralo” després
de la proposta explícita d'adaptador/per compte/consentiment delegat mínim a #46.

## Decisió

S'afegeix Microsoft Graph v1.0 per a les capacitats compatibles d'Exchange
Online dins del nucli de Rust existent. Es mantenen Wails, el pont stdio,
IMAP/SMTP i EWS local (on-premises). L'adopció és explícita per compte, mai
deduïda d'un domini de correu electrònic. Sense migració automàtica, sense
protocol alternatiu de reserva, sense servei públic ni accés només
d'aplicació. Les concessions OAuth existents no canvien; els testimonis del
recurs d'Outlook no s'han de reutilitzar mai com a concessions de Graph. El
consentiment i la política del tenant (inquilí) són requisits separats.

Els permisos es demanen de manera incremental: `Mail.ReadBasic` per a
descobrir carpetes i metadades bàsiques, `Mail.Read` per a la lectura
completa, `Mail.ReadWrite` per a l'edició (no inclou l'enviament) i, per
separat, `Mail.Send`, `Calendars.ReadWrite` o `Contacts.ReadWrite` quan
s'activa la funcionalitat corresponent. Els permisos de bústia compartida i
els punts d'accés de núvols nacionals requereixen els seus propis
fragments de capacitat documentats; la implementació inicial s'adreça al
servei global i a la bústia de l'usuari que ha iniciat la sessió.

## Contractes (#24 / #25)

- Els identificadors de Graph són opacs i distingeixen majúscules i
  minúscules, qualificats per compte i tipus de recurs. Cal enviar
  `Prefer: IdType="ImmutableId"` a cada petició d'element. Un identificador
  de Graph no és un UID d'IMAP, un identificador d'EWS ni un identificador
  de conversa local. Els trasllats a bústies d'arxiu o l'exportació i
  importació el poden canviar. No es correlaciona per assumpte ni per adreça.
- Els enllaços de pàgina i de delta són punts de control opacs del
  proveïdor, lligats al compte i a la col·lecció d'origen. Només se segueixen
  URL HTTPS de Graph v1.0 validats per a aquella col·lecció exacta. Mai no es
  reenvien testimonis bearer a través de redireccions. S'obté una pàgina
  limitada cada vegada; els errors no són captures buides correctes.
- Es preserven les categories d'error de Graph: reautenticació, accés
  denegat, no trobat, conflicte, limitació de peticions, punt de control
  caducat, no disponible, resposta no vàlida i fallada de transport. Es
  retorna el temps d'espera per a reintentar sense esperar ni reintentar a
  cegues. No s'exposen cossos de resposta, credencials ni URL de punts de
  control en errors ni registres.
- Una ronda de delta completa només pot avançar el seu punt de control de
  manera atòmica amb els canvis corresponents de la memòria cau. Les
  lectures incompletes no han de suprimir dades locals. Un punt de control
  rebutjat requereix una ressincronització explícita, no fusionar una primera
  pàgina nova en un recorregut antic. Les escriptures fan servir testimonis
  de concurrència quan s'admeten; un enviament incert es concilia, mai no es
  repeteix automàticament.
- X1 no canvia cap esquema persistent, compte existent ni memòria cau de
  correu. Abans d'activar Graph al conjunt de sessions de correu, cal
  documentar i provar, en el seu fragment d'implementació, la projecció
  exacta, la reversió, la preservació d'esborranys locals i etiquetes i la
  migració de l'emmagatzematge de testimonis. Aquesta decisió permet aquesta
  integració additiva, no la conversió destructiva d'un perfil existent.

## Lliurament

1. #125: adaptador de lectura natiu, concessió de Graph explícita en memòria,
   contractes de transport i de punt de control; validació amb fixtures (dades de prova) i
   loopback. Encara no és un rerefons de compte que l'usuari pugui activar,
   sense intercanvi OAuth i sense canvi de comptes de producció.
2. Consentiment OAuth/PKCE per compte i cicle de vida de credencials segur i
   separat; cancel·lació, renovació, revocació i interfície d'activació explícita.
3. Projecció de correu, recuperació de delta i integració de lectura; després,
   mutacions, conciliació d'esborranys i enviaments i fitxers adjunts amb
   proves per operació.
4. Calendari/contactes i capacitats delegades per separat; cadascuna continua
   sent una mancança explícita fins que s'implementi i es provi. Sense
   dependència de l'API beta per defecte.
5. Acceptació controlada amb el proveïdor i nativa, i artefactes instal·lables
   amb SHA exacte. Aquí no s'autoritza cap experiment amb correu real,
   reconfiguració del tenant ni publicació.

## Fonts i límits

Verificat el 2026-09-09: [permisos](https://learn.microsoft.com/en-us/graph/permissions-reference),
[identificadors](https://learn.microsoft.com/en-us/graph/outlook-immutable-id),
[paginació](https://learn.microsoft.com/en-us/graph/paging),
[limitació de peticions](https://learn.microsoft.com/en-us/graph/throttling),
[abast de carpetes](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0).
La disponibilitat de Graph no equival a la paritat amb eM Client. #46 conserva
el descobriment de l'exposició de comptes i de les operacions no
compatibles; #22 conserva l'acceptació de tot el producte.
