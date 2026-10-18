# ADR-0054: Arxivament automàtic per antiguitat

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: #112 (fila SET-13 del registre d'acceptació, «Correu → Arxivament
  automàtic» d'eM Client 10.4), sobre ADR-0014 (arxiu local) i amb la
  programació d'ADR-0037.

## Decisió

- **Desactivat per defecte, i per compte.** Cada compte amb servidor (IMAP,
  Exchange per EWS, Microsoft Graph) té la seva política a
  `auto_archive_policies` (esquema 62). POP3 i l'arxiu local no la
  tenen: el seu correu ja és en aquest equip.
- **Què diu una política:**
  - antiguitat: N dies (1–3650) o N mesos (1–120); 6 mesos per defecte;
  - carpetes d'origen: la Safata d'entrada per defecte; cada carpeta
    triada pot tenir la seva pròpia antiguitat;
  - destinació: la carpeta Arxiu del compte al servidor, o l'arxiu
    local; amb l'arxiu local, opció de deixar també la còpia del
    servidor;
  - exclosos per defecte: els missatges marcats i els no llegits; dues
    caselles els inclouen.
- **Carpetes que mai no són origen:** Esborranys, Safata de sortida,
  Paperera, Correu brossa i la mateixa carpeta Arxiu (o «Tots» de Gmail).
  Es reconeixen pel seu paper (RFC 6154) i, si el servidor no ho diu, pel seu
  nom. Es mostren a Paràmetres desactivades, amb el motiu; el nucli les
  rebutja encara que se li demanin.
- **Què és «més antic que N»:** la data del missatge (`Date:`) és
  anterior a la mitjanit local del dia que cau N dies o N mesos abans
  d'avui. Un missatge d'aquell mateix dia no hi entra. Els mesos són de
  calendari (el 31 de març menys un mes és el 28 de febrer). Si aquell dia
  comença en un canvi d'hora sense mitjanit, compta des de la primera hora que
  existeix. Un missatge sense data coneguda no s'arxiva mai.
- **Previsualització i confirmació:**
  - abans d'activar-la, i cada vegada que canviï alguna cosa que decideixi què
    es mou (antiguitat, carpetes, destinació, opcions), es mostra quants
    missatges de cada carpeta es mourien ara, des de quina data i cap a on;
  - la previsualització no mou res i retorna una empremta (SHA-256 del
    compte i la política sense l'«activada»);
  - el nucli només accepta activar-la amb aquesta empremta; una política
    canviada sense empremta nova queda sense confirmar i, per tant, no s'executa;
  - desactivar-la i tornar-la a activar sense canvis no demana una altra
    previsualització.
- **Quan s'executa:** com les còpies programades (ADR-0037), mentre
  l'aplicació és oberta: una comprovació cada 5 minuts, la primera uns
  2½ minuts després d'obrir. Una vegada al dia; la primera, a la comprovació
  següent després de confirmar. Una execució que no pot començar (sense
  connexió, sense carpeta Arxiu) es reintenta una hora després, sense
  avançar la diària. Els comptes en pausa no s'executen. «Executar ara»
  fa el mateix a petició, amb la política confirmada. Només hi ha una
  execució en marxa alhora.
- **Com es cerquen els missatges:**
  - IMAP: es pregunta al servidor (`UID SEARCH SENTBEFORE`, amb dos dies de
    marge) i es llegeixen les capçaleres del que s'ha trobat; la data exacta,
    les marques i el Message-ID decideixen;
  - Graph i EWS no ofereixen aquesta cerca per aquesta via: es fa servir el
    que s'ha sincronitzat aquí, de manera que només s'arxiva el que
    l'aplicació ja coneix d'aquella carpeta.
- **A l'Arxiu del servidor:** la mateixa acció que «Arxivar»: `UID MOVE`
  (RFC 6851), o `COPY` + `\Deleted` + `EXPUNGE` si el servidor no té
  MOVE; a Graph i EWS, el moviment propi de cadascun. Es mou en
  tandes de 50; una tanda rebutjada s'anota missatge a missatge.
- **A l'arxiu local (ADR-0014): copiar → comprovar → suprimir.**
  - es llegeixen els bytes originals del servidor (`BODY.PEEK[]`, sense marcar
    res com a llegit) i es desen a `Archived/<dirección>/<carpeta>` de
    l'arxiu local, amb les seves marques de llegit i marcat;
  - la còpia es torna a llegir i es compara byte a byte amb la del
    servidor; si no coincideix o no es pot llegir, se suprimeix la còpia (és
    nostra) i el missatge es queda al servidor;
  - només amb la còpia comprovada se suprimeix del servidor (`\Deleted` +
    `UID EXPUNGE`), en tandes;
  - només és possible en comptes IMAP: Graph i EWS no lliuren aquí els bytes
    originals, i l'opció apareix desactivada amb el motiu.
- **Reprenible i sense duplicats:** cada pas queda a
  `auto_archive_items` (copiat, comprovat). Si l'execució s'interromp:
  - entre copiar i comprovar, o entre comprovar i suprimir, la següent
    torna a llegir l'original, reconeix la còpia ja feta (pel diari, o
    per Message-ID i igualtat de bytes) i no copia una altra vegada;
  - mai no se suprimeix del servidor sense comparar, en aquesta mateixa
    execució, els bytes del servidor amb una còpia local; si l'UID ara anomena
    un altre missatge, els bytes no coincideixen i no se suprimeix res;
  - en el pitjor cas el missatge queda als dos llocs, mai a cap.
  Amb «deixar també al servidor», el que s'ha arxivat es recorda (UID i
  Message-ID) i no es torna a copiar cada dia.
- **Registre de cada execució** (`auto_archive_runs`, les 30 últimes per
  compte): quan, si va ser programada o a petició, destinació, moguts,
  copiats amb còpia al servidor, no moguts, desapareguts abans del seu
  torn i, per a cada missatge que no es va moure, carpeta, assumpte, pas
  (llegir, copiar, comprovar, suprimir, moure) i motiu (fins a 200). Es veu
  a Paràmetres del compte. Una fallada d'una execució programada s'avisa
  encara que Paràmetres estigui tancat.
- **En treure el compte** se'n van amb ell la seva política, el seu registre
  i el seu diari (ADR-0011). El que ja s'ha copiat a l'arxiu local es queda.
- **Restaurar un perfil** (ADR-0010) deixa totes les polítiques desactivades:
  una còpia restaurada en un altre equip no comença a moure correu tota sola.

## Alternatives descartades

- **Triar els missatges amb la memòria cau local també a IMAP:** només veuria
  els missatges recents que l'aplicació ha sincronitzat i deixaria sense
  arxivar justament els més antics.
- **Demanar confirmació abans de cada execució diària:** la política
  confirmada ja diu què es mou; preguntar cada dia ensenya a acceptar sense
  llegir. Canviar-la sí que torna a preguntar.
- **Moure a l'arxiu local amb MOVE del servidor i copiar després:** si la
  còpia fallés, el missatge quedaria només en una carpeta que no és la de la
  destinació triada. Copiar i comprovar abans de suprimir no perd res.
- **Arxivar amb l'aplicació tancada (tasca del sistema):** igual que a
  ADR-0037, exigeix instal·lar alguna cosa fora de l'aplicació a cada
  plataforma.
- **Comptar l'antiguitat per la data d'arribada (INTERNALDATE):** canvia
  en copiar o migrar bústies; la data del missatge és la que la persona veu
  a la llista.
