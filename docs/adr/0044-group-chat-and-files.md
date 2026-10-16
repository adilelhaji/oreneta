# ADR-0044: Grups i fitxers al xat (XMPP)

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: el que ADR-0036 va deixar pendent de #111: grups (MUC, XEP-0045) i
  fitxers (HTTP File Upload, XEP-0363) amb progrés i cancel·lació.

## Decisió

- **Unir-se a un grup:**
  - per la seva adreça (`sala@servicio.ejemplo`) i un sobrenom; la contrasenya
    de la sala, si en té, va al clauer (`chat-room:<cuenta>:<sala>`),
    mai al magatzem;
  - la sala es desa (`chat_rooms`, esquema 58) i s'hi torna a entrar a
    cada connexió nova; una sessió represa (XEP-0198) continua a dins i no
    hi entra una altra vegada;
  - una sala nova s'accepta amb la configuració per defecte («sala
    instantània»), perquè altres hi puguin entrar;
  - el que digui la sala de la nostra entrada (a dins, a fora, contrasenya
    errònia, sobrenom ocupat, només membres, vetat, no existeix, plena) arriba
    a la visualització com a estat de la sala, no com a error genèric.
- **Historial d'un grup:**
  - en entrar es demana a la sala el que s'ha dit des de l'últim missatge desat
    aquí (`<history since>`), o els 50 últims si no hi ha res;
  - si ja coneixem un id de l'arxiu de la sala, també se'n recorre
    l'arxiu (XEP-0313 contra l'adreça de la sala), per pàgines;
  - només compta l'`stanza-id` que posa la sala (`by` igual a la sala);
    un de posat per un altre s'ignora, com al xat directe;
  - l'id d'arxiu d'una sala no es barreja amb el del compte: cada
    conversa té el seu.
- **Un missatge es desa una vegada** també en un grup: pel seu `origin-id`
  o el seu id, i per l'`stanza-id` de la sala. El que és propi i la sala
  retorna (eco) no és un missatge nou: confirma l'enviat i el passa a
  «acceptat». Es reconeix pel sobrenom o, si el sobrenom ha canviat, perquè
  aquest id va sortir d'aquí.
- **Qui va dir què:** cada missatge d'un grup desa el sobrenom de qui
  parla; la sala parlant sense sobrenom i els canvis de tema no són missatges.
- **Estats en un grup:** enviant → enviat → acceptat (ack XEP-0198 o
  eco de la sala). No es demana confirmació de lliurament en un grup. Un error
  retornat per a un id nostre el deixa en «no enviat». Després d'una
  desconnexió, el que no s'ha confirmat queda en «potser no ha arribat» i no
  es reenvia sol, igual que al directe.
- **Sortir:** ja no s'entra a la sala, s'esborra la contrasenya del clauer i
  el que s'ha desat aquí d'aquesta sala. L'arxiu de la sala no es toca.
- **Invitacions:**
  - directes (XEP-0249) o a través de la sala (XEP-0045); es desen
    (`chat_invitations`) i es mostren com a proposta;
  - entrar és decisió de la persona: «Unir-se…» obre el mateix formulari,
    amb l'adreça ja posada, i «Ara no» l'aparta;
  - una contrasenya que porti la invitació va al clauer; la visualització
    només sap que existeix;
  - com a màxim 20 invitacions en espera per compte; una altra més, o una
    per a una sala on ja s'és, no es desa.
- **Enviar un fitxer:**
  - el servei de pujada es cerca al servidor del compte (disco#info
    del domini i dels seus elements), una vegada per sessió;
  - el límit de mida és el del formulari del servei (`max-file-size`):
    un fitxer més gran es rebutja aquí, abans de demanar lloc i sense enviar
    res;
  - es demana un lloc (slot) amb nom i mida, i tant el `PUT` com el
    `GET` han de ser HTTPS; si no, no es fa servir;
  - el fitxer es puja amb `PUT` per HTTPS, amb el servidor intermediari
    (proxy) de l'aplicació i sense seguir redireccions; només passen les
    capçaleres que permet XEP-0363;
  - el progrés arriba cada 256 KB (`chat.progress`) i el final una vegada
    (`chat.uploaded`); cancel·lar talla l'enviament i no surt cap missatge;
  - un cop pujat, l'enllaç surt com a missatge normal, amb l'enllaç al cos
    i com a OOB (XEP-0066), i segueix les regles d'estat de sempre;
    «Tornar a enviar» torna a enviar el mateix enllaç amb el mateix id.
- **Rebre un fitxer:**
  - un missatge amb enllaç OOB es mostra com a fitxer, amb el seu nom
    (últim tram del camí, descodificat i sense barres ni punts al
    principi) i «Desar…»;
  - mai no es baixa sol: només quan la persona tria on desar-lo;
  - només per HTTPS, sense credencials a l'enllaç i sense redireccions;
    s'escriu al costat amb `.part` i es reanomena en acabar.

## Alternatives descartades

- **Demanar sempre a la sala el seu historial complet per MAM:** no totes les
  sales tenen arxiu i el primer accés portaria mesos. N'hi ha prou amb
  l'historial de la sala des de l'últim missatge, i l'arxiu només per a
  omplir buits.
- **Desar la contrasenya de la invitació al magatzem o a la memòria:** el
  magatzem no desa secrets (ADR-0036) i a la memòria es perdria en
  reiniciar.
- **Baixar els fitxers rebuts per a previsualitzar-los:** seria trànsit
  cap a servidors d'altres sense que la persona ho demani.
- **Client HTTP propi sobre `crate::tls` per al certificat fixat:** el
  servei de pujada sol tenir un nom diferent del servidor XMPP, de manera que
  el certificat fixat del compte no li correspon; es fa servir ureq, com a
  #108, amb les arrels habituals i el servidor intermediari de l'aplicació.

## Pendent (#111 continua oberta)

- Missatges privats dins d'una sala: avui s'ignoren.
- Convidar altres des d'aquí, canviar de sobrenom i la llista d'ocupants.
- Xifrar fitxers (XEP-0454) i miniatures.
- Presència, mencions i notificacions del sistema.
- Rocket.Chat; Teams i Slack quan existeixin els registres.
- N5: un servidor XMPP públic amb dos comptes de prova, també per a
  grups i fitxers.
