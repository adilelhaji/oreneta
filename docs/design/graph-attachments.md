# Adjunts a Microsoft Graph (#142)

Sota l'[ADR-0004](../adr/0004-microsoft-graph.md) i amb els contractes existents
de memòria cau de fitxers multimèdia i previsualització. No introdueix cap
emmagatzematge nou: els fitxers van a la memòria cau de fitxers multimèdia de
sempre, amb el mateix camí per compte, carpeta i UID que IMAP i EWS.

## Lectura

- **Sense adjunts.** El cos continua arribant com a JSON i no canvia res.
- **Amb adjunts.** Es llegeix el missatge sencer com a MIME
  (`GET /me/messages/{id}/$value`) amb el permís de lectura (`Mail.Read`).
  Passa pel mateix analitzador que IMAP:
  - escriu cada part a la memòria cau de fitxers multimèdia;
  - reescriu els `cid:` de l'HTML cap a aquests fitxers;
  - deixa l'HTML per al sanejament i la política d'imatges remotes de sempre.
  Llegir el MIME no marca el missatge com a llegit.
- **Tipus.**
  - Els adjunts de fitxer i els elements adjunts (un correu dins d'un altre)
    viatgen dins del MIME i apareixen com sempre.
  - Els adjunts al núvol (`referenceAttachment`) són enllaços, no fitxers. Es
    llisten a part, sense bytes, amb
    `GET /me/messages/{id}/attachments?$select=name,contentType,size,isInline`.
    Es mostren amb el nom i el motiu «Enllaç al núvol: obre'l a Outlook». El
    seu enllaç no se segueix mai i no s'hi envia cap testimoni (token).
  - Si aquest llistat falla, els fitxers que sí que han arribat es mostren
    igualment.
- **Límit.** El MIME es llegeix fins a 64 MiB (`MAX_MIME`). Es rebutja abans de
  llegir-lo si `Content-Length` el supera, o es talla en superar-lo. Aleshores:
  - el text es mostra a partir del JSON;
  - la llista d'adjunts indica «Adjunts no mostrats: aquest missatge supera els
    64 MB que llegeix l'Oreneta»;
  - no es desa res a mitges.
- **Memòria cau.** Un missatge amb adjunts només es dona per desat si tots els
  seus fitxers continuen al disc.
  - Una còpia antiga sense fitxers, d'abans de #142, es torna a llegir.
  - Si falta un fitxer esborrat de la memòria cau, es torna a demanar.
  - Un adjunt marcat com a no disponible no força relectures.
- **Errors.** Un error de lectura és un error, mai un missatge buit. Les
  categories són les de Graph: 401, 403, 404, 429 amb espera, 5xx i resposta no
  vàlida.

## Aïllament

- **Camí per compte.** Els fitxers s'escriuen sota
  `<multimèdia>/<compte>/<carpeta>/<uid>/`, amb els noms sanejats de
  l'analitzador. Un missatge d'un altre compte no pot escriure ni llegir en
  aquest camí.
- **Identificador resolt.** L'identificador de Graph es resol per compte,
  carpeta i UID local abans de demanar res. Un missatge mogut o suprimit dona
  «no trobat», o la còpia de la memòria cau si n'hi ha.

## Proves

- **Transport** (servidor de bucle local):
  - camí `/$value` amb un permís de només lectura;
  - límit de mida com a `TooLarge`;
  - llistat amb `$select`, reconeixement d'enllaços i una sola sol·licitud,
    sense seguir l'enllaç;
  - una pàgina JSON massa gran continua sent «resposta no vàlida».
- **Sessió:**
  - MIME real amb una imatge en línia i un PDF: fitxers al disc, HTML sense
    `cid:` i enllaç al núvol anomenat;
  - la segona lectura surt de la memòria cau;
  - un fitxer esborrat es torna a demanar;
  - un missatge massa gran mostra el text i el motiu;
  - sense adjunts no es demana el MIME;
  - un error és un error.
- **Interfície:** un enllaç al núvol amb tipus imatge es llista com una fitxa amb
  el seu motiu i no es perd.

## Límits

- **Lectura sense streaming.** El MIME es llegeix en memòria fins al límit. Un
  missatge més gran no mostra els seus fitxers: per a això caldria baixar cada
  adjunt per separat, cosa que queda per a més endavant.
- **Baixada interrompuda.** Es tracta com un error de lectura. La propera
  obertura ho torna a intentar.
- **Sense evidència real.** La previsualització al binari natiu i la
  certificació amb un inquilí (tenant) real queden a #98.
