# Calendaris subscrits: lectura segons l'RFC 5545 (#100, #101)

Un calendari subscrit és un fitxer `.ics` publicat per un altre. Oreneta el
baixa i n'expandeix les sèries ell mateix, a `meron-core/src/calendar/subscription.rs`.
Els defectes següents es van reproduir amb fixtures abans de corregir-los.

## Què es corregeix

| Abans | Ara |
|---|---|
| Un esdeveniment de dia sencer es mostrava un dia abans a l'est d'UTC: l'expansió el situava a mitjanit local i el calendari el llegeix com a data UTC. | Es conserva la data de l'esdeveniment, sigui quina sigui la zona de l'equip. |
| Una ocurrència moguda (`RECURRENCE-ID`) apareixia dues vegades, i una de cancel·lada continuava apareixent. | La sèrie s'agrupa per `UID`. L'excepció substitueix l'ocurrència que anomena i, si és cancel·lada, la treu. S'identifica per la data original, de manera que tornar-la a moure actualitza la mateixa fila. |
| `DURATION` s'ignorava i l'esdeveniment durava zero. | `DTEND`; si falta, `DTSTART` + `DURATION`; si tampoc no hi és, un dia per a un esdeveniment de dia sencer (RFC 5545 §3.6.1). |
| Una hora flotant (sense zona) donava una durada zero. | Es llegeix a l'hora de l'equip, que és el que vol dir «flotant». |
| Un `TZID` amb nom de Windows (`W. Europe Standard Time`, com publica Outlook) feia descartar tota la sèrie. | Es tradueix a IANA amb la taula del CLDR abans d'expandir. |
| Un esdeveniment que començava abans de la finestra i continuava dins (de diumenge a dimarts en una setmana que comença el dilluns) desapareixia. | Es cerca cap enrere tant com dura l'esdeveniment, amb un màxim de 31 dies. |
| Una subscripció que fallava en baixar-se o llegir-se aturava la sincronització de la resta de calendaris del compte. | Aquella subscripció conserva els últims esdeveniments i se'n registra el motiu. Les altres s'actualitzen. |
| Els enllaços `webcal://`, la forma habitual de publicar una subscripció, es rebutjaven. | Es baixen per HTTPS. Els altres esquemes es continuen rebutjant. |

## Proves

- **Nucli** (`calendar::subscription::tests`): excepció moguda, cancel·lada i
  `EXDATE`; `DURATION` i finals absents; sèrie de dies sencers; zona de
  Windows a través del canvi d'hora del 25-10-2026; 29 de febrer anual;
  esdeveniment que travessa l'inici de la finestra; hora flotant; `webcal`;
  format de durades; i que cada entrada de la taula de Windows sigui una zona
  real.
- **Zones diferents d'UTC.** La CI executa les proves de calendari també amb
  `TZ=Asia/Tokyo` i `TZ=America/Los_Angeles`. En UTC, data i instant
  coincideixen i l'error dels dies sencers no es veu. Amb el codi anterior i
  `TZ=Europe/Madrid`, la prova de dies sencers falla.
- **Interfície** (`subscriptionUrl.test.ts`): el diàleg accepta `webcal://` i
  `webcals://`, i rebutja el mateix que el nucli.

## Conflictes en editar a Google (#101)

- Editar un esdeveniment o una ocurrència envia `If-Match` amb la versió (etag)
  amb què es va llegir. Si algú l'ha canviat mentrestant, Google respon 412, no
  es desa res i es demana que es torni a obrir. Abans se sobreescrivia en
  silenci.
- La versió nova que retorna Google es desa immediatament, de manera que editar
  dues vegades seguides no dona un fals conflicte.
- Editar tota la sèrie no porta `If-Match`: la versió que es té és la de
  l'ocurrència, no la del mestre.
- Respondre a una invitació llegeix la llista d'assistents i l'escriu amb
  `If-Match`. Si algú s'hi ha afegit entremig, es rellegeix una vegada i es
  conserva.
- Proves: `calendar::google::tests` amb un servidor local que comprova la
  capçalera, el 412 i la relectura.
- **Exchange queda pendent.** Envia `AlwaysOverwrite`, tot i que el seu
  comentari promet el contrari. Per a una sèrie, la clau de canvi que s'envia
  és la de l'ocurrència, de manera que passar a `NeverOverwrite` sense provar-ho
  contra un Exchange real podria rebutjar totes les edicions de sèries.
  Necessita evidència del proveïdor i decidir entre `AutoResolve` i
  `NeverOverwrite`.

## Editar tota la sèrie a Google (#100)

- **La regla no s'esborra.** Una edició enviava `"recurrence": null` quan
  l'editor no havia carregat la regla. Com que és un PATCH, això esborrava la
  regla i la sèrie es quedava en la primera ocurrència. Ara la regla només
  s'envia si n'hi ha una, i mai en l'edició d'una ocurrència solta.
- **La sèrie no s'escurça.** Editar la sèrie des d'una ocurrència escrivia la
  data d'aquella ocurrència al mestre: la sèrie començava allà i perdia les
  anteriors. Ara es llegeix el mestre i se'n conserva la primera data. Canvien
  l'hora del dia, a la zona de l'equip, i la durada. L'escriptura porta l'etag
  del mestre.
- **Moure la sèrie a altres dies** des d'una ocurrència no es fa per aquesta
  via. Cal canviar la regla.
- **Exchange pendent.** `update_fields` té el mateix defecte: escriu l'inici de
  l'ocurrència al mestre i no envia la regla. Corregir-ho requereix llegir el
  mestre per EWS i provar-ho contra un Exchange real. La política del
  repositori no admet enregistraments inventats.

## Dates de les regles i zona de l'equip (#100)

- **Dia de la setmana, dia del mes, mes i data final.** Es calculaven en UTC.
  Un esdeveniment setmanal els dimarts a les 00.30 a Madrid (22:30Z del
  dilluns) es desava com a «cada dilluns» a Google i a Exchange. Una sèrie
  «fins al 30» escrita a l'oest d'UTC durava un dia més. Ara es fa servir la
  data que veu la persona: la data UTC desada si és de dia sencer i, si no, el
  rellotge de l'equip.
- **Zona de l'equip a Windows.** No hi ha `TZ` ni `/etc/localtime`, de manera
  que les sèries de Google s'escrivien en «UTC» i es desplaçaven una hora a
  cada canvi d'hora. Ara es fa servir el nom IANA del sistema
  (`iana-time-zone`), i un `TZ` en format POSIX es descarta.
- **Proves:** regles a Madrid, Tòquio, Los Angeles, Auckland i Honolulu, i
  l'elecció del nom de zona a cada plataforma.

## Pendent

- **Hora ambigua en el canvi d'hora.** Un `DTSTART` a l'hora que es repeteix
  continua fent fallar l'expansió d'aquella sèrie a la biblioteca `rrule`, i la
  sèrie s'omet comptant-la com a il·legible.
- **Fora de les subscripcions.** Els esdeveniments de dia sencer d'Exchange,
  els conflictes en editar i l'edició de sèries completes són a la mateixa
  auditoria i es tracten a part.
